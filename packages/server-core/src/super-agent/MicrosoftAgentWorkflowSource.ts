/** Embedded so compiled Bun/Electron distributions need no loose Python source. */
export const MICROSOFT_AGENT_WORKFLOW_SOURCE = String.raw`
import asyncio
import json
import sys
from importlib.metadata import version
from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler, response_handler

waiters = {}
tasks = set()

def emit(packet):
    print(json.dumps(packet, ensure_ascii=True), flush=True)

class Router(Executor):
    def __init__(self, nodes, target):
        super().__init__(id="team-router")
        self.nodes = nodes
        self.target = target

    @handler
    async def route(self, packet: dict, ctx: WorkflowContext[dict]):
        if len({n["id"] for n in self.nodes}) != len(self.nodes):
            await ctx.yield_output({"error": "Duplicate team node identity"})
            return
        if sum(n["role"] == "coordinator" for n in self.nodes) != 1:
            await ctx.yield_output({"error": "A team requires exactly one coordinator"})
            return
        roles = [n["role"] for n in self.nodes]
        if (any(role not in ("coordinator", "planner", "orchestrator", "worker") for role in roles)
                or roles.count("orchestrator") > 1 or roles.count("planner") > 1
                or ("planner" in roles and "orchestrator" not in roles)):
            await ctx.yield_output({"error": "Invalid orchestration topology"})
            return
        node = next((n for n in self.nodes if n["id"] == self.target), None)
        if node is None:
            await ctx.yield_output({"error": "Unknown workflow target"})
            return
        if packet["kind"] == "task" and node["role"] != "worker":
            await ctx.yield_output({"error": "Tasks must execute on worker nodes"})
            return
        await ctx.send_message(packet, target_id="session:" + self.target)

class SessionNode(Executor):
    def __init__(self, node_id):
        super().__init__(id="session:" + node_id)

    @handler
    async def invoke(self, packet: dict, ctx: WorkflowContext[dict]):
        # Suspend in the SDK's native external-request mechanism. The workflow
        # resumes with one correlated host response; it never runs a model itself.
        await ctx.request_info(packet, dict, request_id=packet["id"])

    @response_handler
    async def complete(self, packet: dict, outcome: dict, ctx: WorkflowContext[dict]):
        if not outcome.get("ok"):
            await ctx.yield_output({"error": outcome.get("error", "Session execution failed")})
        else:
            await ctx.yield_output({"nodeId": packet["nodeId"], "completed": True})

async def stream_run(workflow, packet, **kwargs):
    stream = workflow.run(stream=True, **kwargs)
    requests = []
    async for event in stream:
        if event.type == "request_info":
            requests.append(event)
        if event.type in ["executor_invoked", "executor_completed", "executor_failed", "status"]:
            emit({"type": "event", "id": packet["id"], "event": event.type,
                  "executorId": event.executor_id, "state": event.state.value if event.state else None})
    return await stream.get_final_response(), requests

async def run(packet):
    try:
        router = Router(packet["nodes"], packet["nodeId"])
        builder = WorkflowBuilder(start_executor=router, max_iterations=8,
                                  name="TokenBird node dispatch")
        # Each run owns a separate graph: MAF prohibits concurrent runs on one instance.
        for node in packet["nodes"]:
            builder.add_edge(router, SessionNode(node["id"]))
        workflow = builder.build()
        result, requests = await stream_run(workflow, packet, message=packet)
        if requests:
            if len(requests) != 1 or requests[0].request_id != packet["id"] or requests[0].data.get("nodeId") != packet["nodeId"]:
                raise RuntimeError("Invalid external session request")
            request_id = requests[0].request_id
            future = asyncio.get_running_loop().create_future()
            waiters[request_id] = future
            # TokenBird owns provider credentials, streaming, tools and approvals.
            emit({"type": "invoke", "id": request_id, "nodeId": packet["nodeId"]})
            try:
                outcome = await future
                result, requests = await stream_run(workflow, packet, responses={request_id: outcome})
            finally:
                waiters.pop(request_id, None)
            if requests:
                raise RuntimeError("Session workflow requested a repeated invocation")
        outputs = result.get_outputs()
        if len(outputs) == 1 and "error" in outputs[0]:
            raise RuntimeError(outputs[0]["error"])
        if len(outputs) != 1 or outputs[0]["nodeId"] != packet["nodeId"]:
            raise RuntimeError("Workflow did not complete the assigned node")
        emit({"type": "complete", "id": packet["id"]})
    except Exception as error:
        emit({"type": "error", "id": packet["id"], "error": str(error)})

async def main():
    emit({"type": "ready", "version": version("agent-framework-core")})
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        packet = json.loads(line)
        if packet["type"] == "result":
            future = waiters.get(packet["id"])
            if future is not None and not future.done():
                future.set_result(packet)
        elif packet["type"] == "run":
            task = asyncio.create_task(run(packet))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

asyncio.run(main())
`
