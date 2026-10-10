import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { DRAWIO_VISIO_LAYOUT_SCRIPT, VISIO_SCRIPT, normalizeVisioDrawioXml } from './studio-visio'

const graph = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="group" vertex="1" parent="1" style="shape=group;fillColor=none;strokeColor=none"><mxGeometry x="-100" y="40" width="400" height="300" as="geometry"/></mxCell>
<object id="a" label="&lt;div&gt;中文 &amp;amp; &amp;lt;测试&amp;gt;&lt;/div&gt;&lt;div&gt;第二行&lt;/div&gt;"><mxCell vertex="1" parent="group" style="ellipse;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=20;fontColor=#ff0000;fontStyle=1"><mxGeometry x="20" y="30" width="80" height="40" as="geometry"/></mxCell></object>
<mxCell id="b" value="Decision" vertex="1" parent="group" style="rhombus;fillColor=#d5e8d4"><mxGeometry x="200" y="150" width="60" height="60" as="geometry"/></mxCell>
<mxCell id="port" value="P" vertex="1" parent="b"><mxGeometry x="0.5" y="1" width="10" height="8" relative="1" as="geometry"><mxPoint x="-5" y="-4" as="offset"/></mxGeometry></mxCell>
<mxCell id="e" value="是" edge="1" source="a" target="b" parent="group" style="edgeStyle=orthogonalEdgeStyle;exitX=0.5;exitY=1;entryX=0.5;entryY=0;endArrow=block;dashed=1;strokeColor=#123456"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="60" y="120"/><mxPoint x="230" y="120"/></Array></mxGeometry></mxCell>
<mxCell id="free" edge="1" parent="group" style="endArrow=none"><mxGeometry relative="1" as="geometry"><mxPoint x="0" y="0" as="sourcePoint"/><mxPoint x="-40" y="-80" as="targetPoint"/></mxGeometry></mxCell>
</root></mxGraphModel>`
const fixture = `<mxfile><diagram name="第一张">${graph}</diagram><diagram name="第二张">${graph}</diagram></mxfile>`

async function powershell(script: string, payload: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tokenbird-visio-test-'))
  try {
    const path = join(directory, 'test.ps1')
    await writeFile(path, '\uFEFF' + script, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path], { windowsHide: true })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const done = new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'PowerShell conversion timed out or exited without a report')))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
    const timeout = setTimeout(() => child.kill(), 60_000)
    try { await done } finally { clearTimeout(timeout) }
    return stdout
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('draw.io to Visio conversion', () => {
  it('decompresses every page including mixed compressed/uncompressed documents', () => {
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString('base64')
    expect(normalizeVisioDrawioXml(`<mxfile><diagram name="第一张">${graph}</diagram><diagram name="第二张">${compressed}</diagram></mxfile>`)).toBe(fixture)
    expect(() => normalizeVisioDrawioXml('<mxfile><diagram>bad</diagram></mxfile>')).toThrow('compressed')
    expect(() => normalizeVisioDrawioXml('<!DOCTYPE x>' + fixture)).toThrow('Invalid')
  })

  it.skipIf(process.platform !== 'win32')('preserves styles, labels, hierarchy, small nodes, bends and independent page IDs', async () => {
    const pages = JSON.parse(await powershell(DRAWIO_VISIO_LAYOUT_SCRIPT + '\nConvertTo-Json -InputObject @($pages) -Depth 20 -Compress', { xml: fixture }))
    expect(pages).toHaveLength(2)
    expect(pages[0].name).toBe('第一张')
    const a = pages[0].items.find((item: any) => item.id === 'a')
    expect(a).toMatchObject({ x: -80, y: 70, w: 80, h: 40, label: '中文 & <测试>\r\n第二行', style: { shape: 'ellipse', fillColor: '#fff2cc', fontSize: '20' } })
    expect(pages[0].items.find((item: any) => item.id === 'port')).toMatchObject({ x: 125, y: 246, w: 10, h: 8 })
    expect(pages[0].edges[0]).toMatchObject({ source: 'a', target: 'b', label: '是', points: [{ x: -40, y: 110 }, { x: -40, y: 160 }, { x: 130, y: 160 }, { x: 130, y: 190 }] })
    expect(pages[0].edges[1].points).toEqual([{ x: -100, y: 40 }, { x: -140, y: -40 }])
    expect(pages[0]).toMatchObject({ offsetX: 190, offsetY: 90 })
    expect(pages[1].items).toEqual(pages[0].items)
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('resolves inferred vertical endpoints and rejects broken parent cycles', async () => {
    const simple = '<mxGraphModel><root><mxCell id="a" vertex="1"><mxGeometry x="0" y="0" width="80" height="40"/></mxCell><mxCell id="b" vertex="1"><mxGeometry x="0" y="200" width="80" height="40"/></mxCell><mxCell id="e" edge="1" source="a" target="b"><mxGeometry relative="1"/></mxCell></root></mxGraphModel>'
    const pages = JSON.parse(await powershell(DRAWIO_VISIO_LAYOUT_SCRIPT + '\nConvertTo-Json -InputObject @($pages) -Depth 20 -Compress', { xml: simple }))
    expect(pages[0].edges[0].points).toEqual([{ x: 40, y: 40 }, { x: 40, y: 200 }])
    await expect(powershell(DRAWIO_VISIO_LAYOUT_SCRIPT, { xml: simple.replace('id="a" vertex="1"', 'id="a" vertex="1" parent="b"').replace('id="b" vertex="1"', 'id="b" vertex="1" parent="a"') })).rejects.toThrow('Cyclic')
  }, 30_000)

  // Explicit opt-in: this starts and closes a real Visio instance.
  it.skipIf(process.platform !== 'win32' || process.env.TOKENBIRD_TEST_VISIO !== '1')('creates a native VSDX and keeps endpoints glued after moving a node', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tokenbird-visio-native-'))
    try {
      const report = String.raw`
  $document.SaveAs([string]$payload.output) | Out-Null
  $document.Close() | Out-Null
  $document = $app.Documents.Open([string]$payload.output)
  $page = $document.Pages.Item(1)
  $node = $page.Shapes.Item(2); $edge = $page.Shapes.Item(5)
  $before = $edge.CellsU('BeginX').ResultIU
  $node.CellsU('PinX').ResultIU = $node.CellsU('PinX').ResultIU + 1
  $after = $edge.CellsU('BeginX').ResultIU
  $report = [pscustomobject]@{
    pages=$document.Pages.Count; shapes=$page.Shapes.Count; label=$node.Text; fontSize=$node.CellsU('Char.Size').ResultIU * 72;
    fill=$node.CellsU('FillForegnd').FormulaU; oneD=$edge.OneD; connections=$page.Connects.Count; moved=$after-$before;
    arrow=$edge.CellsU('EndArrow').ResultIU; dashed=$edge.CellsU('LinePattern').ResultIU
  }
  $document.Saved = $true
  $report | ConvertTo-Json -Compress`
      const result = JSON.parse(await powershell(VISIO_SCRIPT.replace("  $document.SaveAs([string]$payload.output) | Out-Null", report), { xml: fixture, output: join(directory, 'native.vsdx') }))
      expect(result).toMatchObject({ pages: 2, shapes: 6, label: '中文 & <测试>\n第二行', oneD: -1, connections: 2, arrow: 4, dashed: 2 })
      expect(result.fontSize).toBeCloseTo(15, 6)
      expect(result.fill).toBe('RGB(255,242,204)')
      expect(result.moved).toBeCloseTo(1, 6)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 120_000)
})
