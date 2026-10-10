# Build-host-only pure tests. Does not access or modify any registry/PATH value.
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/win7-local/installer/install-dependencies.ps1') -Raw
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Merge-UserPath' }, $true)
. ([ScriptBlock]::Create($function.Extent.Text))
function Equal($Actual, $Expected) { if ($Actual -cne $Expected) { throw 'PATH preservation assertion failed' } }
$long = ('C:\existing;' * 400) + '%SystemRoot%\System32'
Equal (Merge-UserPath $long 'D:\Tools\node') ($long + ';D:\Tools\node')
Equal (Merge-UserPath 'C:\A;;' 'D:\B') 'C:\A;;D:\B'
Equal (Merge-UserPath 'C:\A;"d:\tools\NODE\";C:\B' 'D:\Tools\node') 'C:\A;"d:\tools\NODE\";C:\B'
Equal (Merge-UserPath '%SystemRoot%\System32' (Join-Path $env:SystemRoot 'System32')) '%SystemRoot%\System32'
Equal (Merge-UserPath '' 'D:\B') 'D:\B'
$caught = $false
try { Merge-UserPath ('x' * 32759) 'D:\B' | Out-Null } catch { $caught = $true }
if (!$caught) { throw 'Oversize PATH was not rejected' }
$caught = $false
try { Merge-UserPath '' 'D:\B;C:\injected' | Out-Null } catch { $caught = $true }
if (!$caught) { throw 'PATH separator injection was not rejected' }
Write-Host 'PASS: long PATH, unexpanded variables, exact prefix preservation, case/quotes deduplication, length and separator guards'
