/** Embedded so compiled Bun/Electron distributions need no loose Python source. */
export const MICROSOFT_AGENT_WORKFLOW_SOURCE = String.raw`
import asyncio
import json
import sys
from importlib.metadata import version
from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler

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
        if any(n["role"] not in ["coordinator", "orchestrator", "worker"] for n in self.nodes) or sum(n["role"] == "orchestrator" for n in self.nodes) > 1:
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
        request_id = packet["id"]
        future = asyncio.get_running_loop().create_future()
        waiters[request_id] = future
        try:
            # TokenBird owns provider credentials, streaming, tools and approvals.
            emit({"type": "invoke", "id": request_id, "nodeId": packet["nodeId"]})
            outcome = await future
            if not outcome.get("ok"):
                await ctx.yield_output({"error": outcome.get("error", "Session execution failed")})
            else:
                await ctx.yield_output({"nodeId": packet["nodeId"], "completed": True})
        finally:
            waiters.pop(request_id, None)

async def run(packet):
    try:
        router = Router(packet["nodes"], packet["nodeId"])
        builder = WorkflowBuilder(start_executor=router)
        # Each node is an external session executor; only the routed node runs.
        for node in packet["nodes"]:
            builder.add_edge(router, SessionNode(node["id"]))
        events = await builder.build().run(packet)
        outputs = events.get_outputs()
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
