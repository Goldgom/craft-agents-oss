import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Visio accepts native shapes and connectors through its Windows COM interface.
// Input crosses the process boundary through stdin as JSON, never shell text.
const VISIO_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$settings = New-Object System.Xml.XmlReaderSettings
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader($payload.xml)), $settings)
$xml = New-Object System.Xml.XmlDocument
$xml.XmlResolver = $null
$xml.Load($reader)
$reader.Close()
$cells = @($xml.SelectNodes('//mxCell[@vertex="1"]'))
if ($cells.Count -eq 0) { throw 'The draw.io document has no Visio-compatible nodes' }
if ($cells.Count -gt 1000) { throw 'The diagram has too many nodes for Visio export' }
$culture = [System.Globalization.CultureInfo]::InvariantCulture
function Number($value, $default) {
  $result = 0.0
  if ([double]::TryParse([string]$value, [System.Globalization.NumberStyles]::Float, $culture, [ref]$result)) { return $result }
  return [double]$default
}
$items = @()
$maxX = 0.0; $maxY = 0.0
foreach ($cell in $cells) {
  $geometry = $cell.SelectSingleNode('mxGeometry')
  if ($null -eq $geometry) { continue }
  $x = Number $geometry.GetAttribute('x') 0
  $y = Number $geometry.GetAttribute('y') 0
  $w = [Math]::Max(30, (Number $geometry.GetAttribute('width') 180))
  $h = [Math]::Max(20, (Number $geometry.GetAttribute('height') 54))
  $maxX = [Math]::Max($maxX, $x + $w)
  $maxY = [Math]::Max($maxY, $y + $h)
  $label = [System.Net.WebUtility]::HtmlDecode(($cell.GetAttribute('value') -replace '<[^>]+>', ''))
  $items += [pscustomobject]@{ id=$cell.GetAttribute('id'); x=$x; y=$y; w=$w; h=$h; label=$label }
}
if ($items.Count -eq 0) { throw 'The draw.io document has no positioned nodes' }
$pageWidth = [Math]::Max(10.0, ($maxX + 100) / 96.0)
$pageHeight = [Math]::Max(7.5, ($maxY + 100) / 96.0)
$app = $null; $document = $null
try {
  $app = New-Object -ComObject Visio.Application
  $app.Visible = $false
  $document = $app.Documents.Add('')
  $page = $app.ActivePage
  $page.PageSheet.CellsU('PageWidth').FormulaU = $pageWidth.ToString($culture) + ' in'
  $page.PageSheet.CellsU('PageHeight').FormulaU = $pageHeight.ToString($culture) + ' in'
  $byId = @{}
  foreach ($item in $items) {
    $x1 = ($item.x + 50) / 96.0
    $x2 = ($item.x + $item.w + 50) / 96.0
    $y1 = $pageHeight - ($item.y + $item.h + 50) / 96.0
    $y2 = $pageHeight - ($item.y + 50) / 96.0
    $shape = $page.DrawRectangle($x1, $y1, $x2, $y2)
    $shape.Text = $item.label
    $shape.CellsU('FillForegnd').FormulaU = 'RGB(218,232,252)'
    $shape.CellsU('LineColor').FormulaU = 'RGB(108,142,191)'
    $byId[$item.id] = $item
  }
  foreach ($edge in @($xml.SelectNodes('//mxCell[@edge="1"]'))) {
    $source = $byId[$edge.GetAttribute('source')]
    $target = $byId[$edge.GetAttribute('target')]
    if ($null -eq $source -or $null -eq $target) { continue }
    $sx = ($source.x + $source.w + 50) / 96.0
    $sy = $pageHeight - ($source.y + $source.h / 2 + 50) / 96.0
    $tx = ($target.x + 50) / 96.0
    $ty = $pageHeight - ($target.y + $target.h / 2 + 50) / 96.0
    $line = $page.DrawLine($sx, $sy, $tx, $ty)
    $line.CellsU('LineColor').FormulaU = 'RGB(108,142,191)'
  }
  $document.SaveAs([string]$payload.output) | Out-Null
} finally {
  if ($null -ne $document) { try { $document.Close() | Out-Null } catch {} }
  if ($null -ne $app) { try { $app.Quit() | Out-Null } catch {} }
}
`

export async function exportDrawioToVisio(xml: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Visio export requires Windows and Microsoft Visio')
  if (typeof xml !== 'string' || xml.length > 5_000_000 || !xml.includes('mxGraphModel') || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error('Invalid or oversized draw.io document')
  }
  const directory = await mkdtemp(join(tmpdir(), 'tokenbird-visio-'))
  const scriptPath = join(directory, 'export.ps1')
  const outputPath = join(directory, 'mindmap.vsdx')
  try {
    await writeFile(scriptPath, VISIO_SCRIPT, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 4000) })
    const exit = new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => resolve(code ?? 1))
    })
    child.stdin.end(JSON.stringify({ xml, output: outputPath }))
    const timeout = setTimeout(() => child.kill(), 60_000)
    try {
      if (await exit !== 0) throw new Error(`Visio export failed: ${stderr.slice(0, 500) || 'Visio could not create a document'}`)
    } finally { clearTimeout(timeout) }
    return (await readFile(outputPath)).toString('base64')
  } finally {
    await unlink(scriptPath).catch(() => {})
    await unlink(outputPath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
}
