import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// Layout is independent of COM so tests can exercise the real conversion
// without requiring Visio. All coordinates in the layout are draw.io pixels.
export const DRAWIO_VISIO_LAYOUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$settings = New-Object System.Xml.XmlReaderSettings
$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
$settings.XmlResolver = $null
$reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader($payload.xml)), $settings)
$xml = New-Object System.Xml.XmlDocument
$xml.XmlResolver = $null
try { $xml.Load($reader) } finally { $reader.Close() }
$culture = [System.Globalization.CultureInfo]::InvariantCulture
function Number($value, $default) {
  $result = 0.0
  if ([double]::TryParse([string]$value, [System.Globalization.NumberStyles]::Float, $culture, [ref]$result) -and ![double]::IsNaN($result) -and ![double]::IsInfinity($result)) { return $result }
  return [double]$default
}
function Style($cell) {
  $s = @{}
  foreach ($part in $cell.GetAttribute('style').Split(';')) {
    $pair = $part -split '=', 2
    if ($pair.Count -eq 2) { $s[$pair[0]] = $pair[1] }
    elseif ($part -in @('ellipse','rhombus','triangle','hexagon')) { $s.shape = $part }
    elseif ($part -eq 'text') { $s.fillColor = 'none'; $s.strokeColor = 'none' }
  }
  return $s
}
function Label($cell) {
  $value = $cell.GetAttribute('value')
  if ($cell.ParentNode.LocalName -in @('object','UserObject')) { $value = $cell.ParentNode.GetAttribute('label') }
  if ((Style $cell).html -eq '1') {
    $value = $value -replace '(?i)<br\s*/?>', [Environment]::NewLine -replace '(?i)</(?:div|p|li|h[1-6])\s*>', [Environment]::NewLine -replace '<[^>]+>', ''
    $value = [System.Net.WebUtility]::HtmlDecode($value).TrimEnd([char[]]@([char]13,[char]10))
  }
  return $value
}
function Point($x, $y) { return [pscustomobject]@{ x=[double]$x; y=[double]$y } }
function Bounds($id, $visiting) {
  if ($boundsById.ContainsKey($id)) { return $boundsById[$id] }
  if ($visiting.ContainsKey($id)) { throw 'Cyclic draw.io parent relationship' }
  $cell = $cellsById[$id]
  if ($null -eq $cell) { return $null }
  $g = $cell.SelectSingleNode('mxGeometry')
  if ($null -eq $g) { return $null }
  $visiting[$id] = $true
  $parent = Bounds $cell.GetAttribute('parent') $visiting
  $x = Number $g.GetAttribute('x') 0; $y = Number $g.GetAttribute('y') 0
  if ($null -ne $parent) {
    if ($g.GetAttribute('relative') -eq '1') { $x *= $parent.w; $y *= $parent.h }
    $x += $parent.x; $y += $parent.y
  }
  $offset = $g.SelectSingleNode('mxPoint[@as="offset"]')
  if ($null -ne $offset) { $x += Number $offset.GetAttribute('x') 0; $y += Number $offset.GetAttribute('y') 0 }
  $result = [pscustomobject]@{ x=$x; y=$y; w=[Math]::Max(0.1, (Number $g.GetAttribute('width') 180)); h=[Math]::Max(0.1, (Number $g.GetAttribute('height') 54)) }
  $boundsById[$id] = $result
  $visiting.Remove($id)
  return $result
}
function Terminal($item, $toward, $s, $prefix) {
  $cx = $item.x + $item.w / 2; $cy = $item.y + $item.h / 2
  $dx = $toward.x - $cx; $dy = $toward.y - $cy
  if ($s.ContainsKey($prefix + 'X') -and $s.ContainsKey($prefix + 'Y')) {
    $dx = ((Number $s[$prefix + 'X'] 0.5) - 0.5) * $item.w
    $dy = ((Number $s[$prefix + 'Y'] 0.5) - 0.5) * $item.h
    if ($s[$prefix + 'Perimeter'] -eq '0') { return Point ($cx + $dx) ($cy + $dy) }
  }
  if ([Math]::Abs($dx) + [Math]::Abs($dy) -lt 0.0001) { $dx = 1 }
  $nx = 2 * $dx / $item.w; $ny = 2 * $dy / $item.h
  $scale = 1 / [Math]::Max([Math]::Abs($nx), [Math]::Abs($ny))
  if ($item.style.shape -eq 'ellipse') { $scale = 1 / [Math]::Sqrt($nx * $nx + $ny * $ny) }
  elseif ($item.style.shape -eq 'rhombus') { $scale = 1 / ([Math]::Abs($nx) + [Math]::Abs($ny)) }
  return Point ($cx + $dx * $scale + (Number $s[$prefix + 'Dx'] 0)) ($cy + $dy * $scale + (Number $s[$prefix + 'Dy'] 0))
}
$graphs = @($xml.SelectNodes('/mxfile/diagram/mxGraphModel | /mxGraphModel'))
if ($graphs.Count -eq 0) { throw 'The draw.io document has no uncompressed pages' }
$pages = @(); $total = 0
foreach ($graph in $graphs) {
  $cellsById = @{}; $boundsById = @{}; $itemsById = @{}; $items = @(); $edges = @()
  $cells = @($graph.SelectNodes('root/mxCell | root/object/mxCell | root/UserObject/mxCell'))
  foreach ($cell in $cells) {
    $id = $cell.GetAttribute('id')
    if (!$id -and $cell.ParentNode.LocalName -ne 'root') { $id = $cell.ParentNode.GetAttribute('id') }
    if (!$id -or $cellsById.ContainsKey($id)) { throw 'Missing or duplicate draw.io cell ID' }
    $cellsById[$id] = $cell
  }
  foreach ($id in @($cellsById.Keys)) {
    $cell = $cellsById[$id]
    if ($cell.GetAttribute('vertex') -ne '1' -or $cell.GetAttribute('visible') -eq '0') { continue }
    $b = Bounds $id @{}
    if ($null -eq $b) { continue }
    $itemsById[$id] = [pscustomobject]@{ id=$id; x=$b.x; y=$b.y; w=$b.w; h=$b.h; label=(Label $cell); style=(Style $cell) }
  }
  # XML order is the drawing order: containers must stay behind their children.
  foreach ($cell in $cells) {
    $id = $cell.GetAttribute('id'); if (!$id) { $id = $cell.ParentNode.GetAttribute('id') }
    if ($itemsById.ContainsKey($id)) { $items += $itemsById[$id] }
  }
  foreach ($cell in $cells) {
    if ($cell.GetAttribute('edge') -ne '1' -or $cell.GetAttribute('visible') -eq '0') { continue }
    $s = Style $cell; $g = $cell.SelectSingleNode('mxGeometry')
    $source = $itemsById[$cell.GetAttribute('source')]; $target = $itemsById[$cell.GetAttribute('target')]
    $parent = Bounds $cell.GetAttribute('parent') @{}
    $ox = 0; $oy = 0; if ($null -ne $parent) { $ox = $parent.x; $oy = $parent.y }
    $waypoints = @(); $start = $null; $end = $null
    if ($null -ne $g) {
      foreach ($p in @($g.SelectNodes('Array[@as="points"]/mxPoint'))) { $waypoints += Point ((Number $p.GetAttribute('x') 0) + $ox) ((Number $p.GetAttribute('y') 0) + $oy) }
      $p = $g.SelectSingleNode('mxPoint[@as="sourcePoint"]'); if ($null -ne $p) { $start = Point ((Number $p.GetAttribute('x') 0) + $ox) ((Number $p.GetAttribute('y') 0) + $oy) }
      $p = $g.SelectSingleNode('mxPoint[@as="targetPoint"]'); if ($null -ne $p) { $end = Point ((Number $p.GetAttribute('x') 0) + $ox) ((Number $p.GetAttribute('y') 0) + $oy) }
    }
    if ($null -ne $source) { $start = Point ($source.x + $source.w / 2) ($source.y + $source.h / 2) }
    if ($null -ne $target) { $end = Point ($target.x + $target.w / 2) ($target.y + $target.h / 2) }
    if ($null -eq $start -or $null -eq $end) { throw 'A draw.io connector has no resolvable endpoint' }
    $towardStart = $end; $towardEnd = $start
    if ($waypoints.Count -gt 0) { $towardStart = $waypoints[0]; $towardEnd = $waypoints[-1] }
    if ($null -ne $source) { $start = Terminal $source $towardStart $s 'exit' }
    if ($null -ne $target) { $end = Terminal $target $towardEnd $s 'entry' }
    if ($waypoints.Count -eq 0 -and ($s.edgeStyle -match 'orthogonal|elbow|entityRelation' -or $s.orthogonal -eq '1')) {
      $horizontal = [Math]::Abs($end.x - $start.x) -ge [Math]::Abs($end.y - $start.y)
      if ($s.ContainsKey('exitX')) { $horizontal = (Number $s.exitX 0.5) -ne 0.5 }
      if ($s.elbow -eq 'vertical') { $horizontal = $false }
      if ($horizontal) { $middle = ($start.x + $end.x) / 2; $waypoints = @((Point $middle $start.y), (Point $middle $end.y)) }
      else { $middle = ($start.y + $end.y) / 2; $waypoints = @((Point $start.x $middle), (Point $end.x $middle)) }
    }
    $edges += [pscustomobject]@{ source=$cell.GetAttribute('source'); target=$cell.GetAttribute('target'); points=@($start) + $waypoints + @($end); label=(Label $cell); style=$s }
  }
  $total += $items.Count + $edges.Count
  if ($total -gt 2000) { throw 'The diagram has too many shapes for Visio export' }
  $minX = 0.0; $minY = 0.0; $maxX = 0.0; $maxY = 0.0
  foreach ($item in $items) { $minX = [Math]::Min($minX, $item.x); $minY = [Math]::Min($minY, $item.y); $maxX = [Math]::Max($maxX, $item.x + $item.w); $maxY = [Math]::Max($maxY, $item.y + $item.h) }
  foreach ($edge in $edges) { foreach ($p in $edge.points) { $minX = [Math]::Min($minX, $p.x); $minY = [Math]::Min($minY, $p.y); $maxX = [Math]::Max($maxX, $p.x); $maxY = [Math]::Max($maxY, $p.y) } }
  $name = 'Mind Map'; if ($graph.ParentNode.LocalName -eq 'diagram') { $name = $graph.ParentNode.GetAttribute('name') }; if (!$name) { $name = 'Mind Map' }
  $pages += [pscustomobject]@{ name=$name; items=$items; edges=$edges; offsetX=50-$minX; offsetY=50-$minY; width=[Math]::Max(960, $maxX-$minX+100); height=[Math]::Max(720, $maxY-$minY+100) }
}
if ($total -eq 0) { throw 'The draw.io document has no positioned shapes' }
`

export const VISIO_SCRIPT = DRAWIO_VISIO_LAYOUT_SCRIPT + String.raw`
function Formula($shape, $name, $value) { $shape.CellsU($name).FormulaU = [string]$value }
function Color($value, $default) {
  if ($value -match '^#([0-9a-fA-F]{6})$') {
    $hex = $Matches[1]
    return 'RGB(' + [Convert]::ToInt32($hex.Substring(0,2),16) + ',' + [Convert]::ToInt32($hex.Substring(2,2),16) + ',' + [Convert]::ToInt32($hex.Substring(4,2),16) + ')'
  }
  return $default
}
function Arrow($value, $default) {
  if (!$value) { $value = $default }
  switch -Regex ($value) { '^none$' { return 0 }; '^open' { return 1 }; '^classic' { return 5 }; '^block' { return 4 }; '^diamond' { return 10 }; '^oval$' { return 8 }; default { return 0 } }
}
function ApplyStyle($shape, $s, $isEdge) {
  Formula $shape 'LineColor' (Color $s.strokeColor 'RGB(0,0,0)')
  Formula $shape 'LinePattern' $(if ($s.strokeColor -eq 'none') { 0 } elseif ($s.dashed -eq '1') { 2 } else { 1 })
  Formula $shape 'LineWeight' (((Number $s.strokeWidth 1) / 96).ToString($culture) + ' in')
  Formula $shape 'FillPattern' $(if ($isEdge -or $s.fillColor -eq 'none' -or $s.shape -eq 'group') { 0 } else { 1 })
  Formula $shape 'FillForegnd' (Color $s.fillColor 'RGB(255,255,255)')
  Formula $shape 'Char.Color' (Color $s.fontColor 'RGB(0,0,0)')
  Formula $shape 'Char.Size' (((Number $s.fontSize 12) * 0.75).ToString($culture) + ' pt')
  Formula $shape 'Char.Style' ([int](Number $s.fontStyle 0) -band 7)
  if ($s.fontFamily) { Formula $shape 'Char.Font' ('FONT("' + $s.fontFamily.Replace('"','') + '")') }
  Formula $shape 'Para.HorzAlign' $(if ($s.align -eq 'left') { 0 } elseif ($s.align -eq 'right') { 2 } else { 1 })
  Formula $shape 'VerticalAlign' $(if ($s.verticalAlign -eq 'top') { 0 } elseif ($s.verticalAlign -eq 'bottom') { 2 } else { 1 })
  foreach ($side in @('Left','Right','Top','Bottom')) {
    $spacing = (Number $s.spacing 2) + (Number $s['spacing' + $side] 0)
    Formula $shape ($side + 'Margin') (($spacing / 96).ToString($culture) + ' in')
  }
  $opacity = [Math]::Max(0, [Math]::Min(100, (Number $s.opacity 100)))
  Formula $shape 'FillForegndTrans' ((100 - $opacity * (Number $s.fillOpacity 100) / 100).ToString($culture) + '%')
  Formula $shape 'LineColorTrans' ((100 - $opacity * (Number $s.strokeOpacity 100) / 100).ToString($culture) + '%')
  if ($isEdge) { Formula $shape 'BeginArrow' (Arrow $s.startArrow 'none'); Formula $shape 'EndArrow' (Arrow $s.endArrow 'classic') }
  elseif ($s.rounded -eq '1') { Formula $shape 'Rounding' '0.1 in' }
}
function X($x) { return ($x + $layout.offsetX) / 96 }
function Y($y) { return ($layout.height - $y - $layout.offsetY) / 96 }
$app = $null; $document = $null
try {
  $app = New-Object -ComObject Visio.Application
  $app.Visible = $false
  $app.AlertResponse = 7
  $document = $app.Documents.Add('')
  for ($pageIndex = 0; $pageIndex -lt $pages.Count; $pageIndex++) {
    $layout = $pages[$pageIndex]
    $page = $document.Pages.Item(1)
    if ($pageIndex -gt 0) { $page = $document.Pages.Add() }
    $page.Name = $layout.name + $(if ($pageIndex -gt 0) { ' ' + ($pageIndex + 1) } else { '' })
    Formula $page.PageSheet 'PageWidth' (($layout.width / 96).ToString($culture) + ' in')
    Formula $page.PageSheet 'PageHeight' (($layout.height / 96).ToString($culture) + ' in')
    $byId = @{}; $itemsById = @{}
    foreach ($item in $layout.items) {
      $x1 = X $item.x; $x2 = X ($item.x + $item.w)
      $y1 = Y ($item.y + $item.h); $y2 = Y $item.y
      if ($item.style.shape -eq 'ellipse') { $shape = $page.DrawOval($x1, $y1, $x2, $y2) }
      elseif ($item.style.shape -in @('rhombus','triangle','hexagon')) {
        $cx = ($x1+$x2)/2; $cy = ($y1+$y2)/2
        $coords = @($cx,$y2,$x2,$cy,$cx,$y1,$x1,$cy,$cx,$y2)
        if ($item.style.shape -eq 'triangle') { $coords = @($x1,$y2,$x2,$cy,$x1,$y1,$x1,$y2) }
        if ($item.style.shape -eq 'hexagon') { $q = ($x2-$x1)/4; $coords = @(($x1+$q),$y2,($x2-$q),$y2,$x2,$cy,($x2-$q),$y1,($x1+$q),$y1,$x1,$cy,($x1+$q),$y2) }
        $shape = $page.DrawPolyline([double[]]$coords, 0)
      } else { $shape = $page.DrawRectangle($x1, $y1, $x2, $y2) }
      $shape.Text = $item.label
      ApplyStyle $shape $item.style $false
      $angle = Number $item.style.rotation 0
      if ($item.style.shape -in @('triangle','hexagon')) {
        switch ($item.style.direction) { 'north' { $angle -= 90 }; 'south' { $angle += 90 }; 'west' { $angle += 180 } }
      }
      Formula $shape 'Angle' ((-$angle).ToString($culture) + ' deg')
      $byId[$item.id] = $shape; $itemsById[$item.id] = $item
    }
    foreach ($edge in $layout.edges) {
      $coords = @(); foreach ($p in $edge.points) { $coords += @((X $p.x), (Y $p.y)) }
      # visPolyline1D keeps bends and exposes BeginX/EndX for real glue.
      $line = $page.DrawPolyline([double[]]$coords, 8)
      $line.Text = $edge.label
      ApplyStyle $line $edge.style $true
      if ($edge.style.rounded -eq '1') { Formula $line 'Rounding' '0.1 in' }
      foreach ($terminal in @('source','target')) {
        $id = $edge.$terminal
        if ($byId.ContainsKey($id)) {
          $item = $itemsById[$id]
          $p = $edge.points[0]; $cell = 'BeginX'
          if ($terminal -eq 'target') { $p = $edge.points[-1]; $cell = 'EndX' }
          $line.CellsU($cell).GlueToPos($byId[$id], ($p.x-$item.x)/$item.w, 1-($p.y-$item.y)/$item.h)
        }
      }
    }
  }
  $document.SaveAs([string]$payload.output) | Out-Null
} finally {
  if ($null -ne $document) { try { $document.Close() | Out-Null } catch {} }
  if ($null -ne $app) { try { $app.Quit() | Out-Null } catch {} }
}
`

export function normalizeVisioDrawioXml(xml: string): string {
  if (typeof xml !== 'string' || xml.length > 5_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or oversized draw.io document')
  const normalized = xml.replace(/(<diagram\b[^>]*>)([^<]+)(<\/diagram>)/g, (_match, open: string, encoded: string, close: string) => {
    try {
      const graph = decodeURIComponent(inflateRawSync(Buffer.from(encoded.trim(), 'base64'), { maxOutputLength: 5_000_000 }).toString('utf8'))
      if (!/^\s*<mxGraphModel\b/.test(graph)) throw new Error('Invalid graph')
      return `${open}${graph}${close}`
    } catch { throw new Error('Cannot read the compressed draw.io diagram') }
  })
  if (normalized.length > 5_000_000 || !normalized.includes('<mxGraphModel') || /<!DOCTYPE|<!ENTITY/i.test(normalized)) throw new Error('Invalid or oversized draw.io document')
  return normalized
}

export async function exportDrawioToVisio(xml: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Visio export requires Windows and Microsoft Visio')
  xml = normalizeVisioDrawioXml(xml)
  const directory = await mkdtemp(join(tmpdir(), 'tokenbird-visio-'))
  const scriptPath = join(directory, 'export.ps1')
  const outputPath = join(directory, 'mindmap.vsdx')
  try {
    // Windows PowerShell needs a BOM to read UTF-8 scripts reliably.
    await writeFile(scriptPath, '\uFEFF' + VISIO_SCRIPT, 'utf8')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 4000) })
    const exit = new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)) })
    child.stdin.on('error', () => { /* Process errors/exit carry the export failure. */ })
    child.stdin.end(JSON.stringify({ xml, output: outputPath }))
    const timeout = setTimeout(() => child.kill(), 60_000)
    try { if (await exit !== 0) throw new Error(`Visio export failed: ${stderr.slice(0, 1000) || 'Visio could not create a document'}`) }
    finally { clearTimeout(timeout) }
    return (await readFile(outputPath)).toString('base64')
  } finally {
    await unlink(scriptPath).catch(() => {})
    await unlink(outputPath).catch(() => {})
    await rmdir(directory).catch(() => {})
  }
}
