import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { MICROSOFT_AGENT_WORKFLOW_SOURCE } from './MicrosoftAgentWorkflowSource'

export interface SuperAgentWorkflowInput {
  nodeId: string
  kind: string
  nodes: Array<{ id: string; role: 'coordinator' | 'orchestrator' | 'worker' }>
}

export interface SuperAgentWorkflow {
  prepare?(): Promise<void>
  run(input: SuperAgentWorkflowInput, invoke: () => Promise<void>): Promise<void>
  close(): void
}

type PendingRun = {
  nodeId: string
  invoke: () => Promise<void>
  invoked: boolean
  resolve: () => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** MAF executes the graph; session adapters keep the existing runtime and tool policy. */
export class MicrosoftAgentWorkflow implements SuperAgentWorkflow {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private pending = new Map<string, PendingRun>()
  private closed = false

  constructor(private readonly python = process.env.TOKENBIRD_AGENT_FRAMEWORK_PYTHON || process.env.CRAFT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) {}

  private start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Agent Framework is shutting down'))
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.python, ['-u', '-c', MICROSOFT_AGENT_WORKFLOW_SOURCE], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      })
      this.child = child
      let stderr = ''
      let failed = false
      const timer = setTimeout(() => fail(new Error('Agent Framework startup timed out')), 120_000)
      const fail = (error: Error) => {
        if (failed) return
        failed = true
        clearTimeout(timer)
        const detail = new Error(`${error.message}. Install agent-framework-core==1.21.0 and set TOKENBIRD_AGENT_FRAMEWORK_PYTHON to that Python interpreter.${stderr ? `\n${stderr}` : ''}`)
        reject(detail)
        for (const run of this.pending.values()) { if (run.timer) clearTimeout(run.timer); run.reject(detail) }
        this.pending.clear()
        if (this.child === child) { this.child = undefined; this.ready = undefined }
        child.kill()
      }
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4_000) })
      child.once('error', fail)
      child.once('exit', code => fail(new Error(`Agent Framework process exited (${code})`)))
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const packet = JSON.parse(line)
          if (packet.type === 'ready') {
            if (packet.version !== '1.21.0') { fail(new Error(`Unsupported Agent Framework version ${packet.version}`)); return }
            clearTimeout(timer); resolve(); return
          }
          const run = this.pending.get(packet.id)
          if (!run) return
          if (packet.type === 'invoke') {
            if (run.invoked || packet.nodeId !== run.nodeId) { fail(new Error('Invalid Agent Framework node invocation')); return }
            run.invoked = true
            if (run.timer) clearTimeout(run.timer)
            void Promise.resolve().then(run.invoke).then(
              () => { if (this.child === child && this.pending.has(packet.id)) child.stdin.write(JSON.stringify({ type: 'result', id: packet.id, ok: true }) + '\n') },
              error => { if (this.child === child && this.pending.has(packet.id)) child.stdin.write(JSON.stringify({ type: 'result', id: packet.id, ok: false, error: String(error) }) + '\n') },
            )
          } else if (packet.type === 'complete' || packet.type === 'error') {
            if (run.timer) clearTimeout(run.timer)
            this.pending.delete(packet.id)
            if (packet.type === 'error') run.reject(new Error(packet.error || 'Agent Framework workflow failed'))
            else if (!run.invoked) run.reject(new Error('Agent Framework skipped session execution'))
            else run.resolve()
          }
        } catch { fail(new Error('Invalid Agent Framework protocol response')) }
      })
      child.stdin.on('error', fail)
    })
    return this.ready
  }

  async run(input: SuperAgentWorkflowInput, invoke: () => Promise<void>): Promise<void> {
    await this.start()
    if (this.closed || !this.child) throw new Error('Agent Framework is unavailable')
    return new Promise<void>((resolve, reject) => {
      const id = randomUUID()
      const run: PendingRun = { nodeId: input.nodeId, invoke, invoked: false, resolve, reject }
      run.timer = setTimeout(() => {
        // Kill the transport so a late invoke cannot execute an expired assignment.
        this.child?.kill()
      }, 30_000)
      this.pending.set(id, run)
      this.child!.stdin.write(JSON.stringify({ type: 'run', id, ...input }) + '\n')
    })
  }

  prepare(): Promise<void> { return this.start() }

  close(): void {
    this.closed = true
    for (const run of this.pending.values()) { if (run.timer) clearTimeout(run.timer); run.reject(new Error('Agent Framework is shutting down')) }
    this.pending.clear()
    this.child?.kill()
    this.child = undefined
  }
}
