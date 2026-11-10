# Regression for the VM's .NET 3.5 SHA256Managed without public Dispose().
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/win7-local/installer/install-dependencies.ps1') -Raw
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-Hash' }, $true)
$script:cleared = $false
$script:computed = $false
function New-TestLegacySha {
    # Match the old public surface; deliberately provide no Dispose method.
    $legacy = New-Object PSObject -Property @{ Inner=[Security.Cryptography.SHA256]::Create() }
    $legacy | Add-Member ScriptMethod ComputeHash {
        param($stream)
        $script:computed = $true
        return ,($this.Inner.ComputeHash($stream))
    }
    $legacy | Add-Member ScriptMethod Clear { $script:cleared = $true; $this.Inner.Clear() }
    return $legacy
}
. ([ScriptBlock]::Create($function.Extent.Text.Replace('[Security.Cryptography.SHA256]::Create()', '(New-TestLegacySha)')))
$file = Join-Path $env:TEMP ('tokenbird-legacy-hash-' + [Guid]::NewGuid().ToString('N') + '.txt')
try {
    [IO.File]::WriteAllText($file, 'abc', (New-Object Text.UTF8Encoding($false)))
    $digest = Get-Hash $file
    if ($digest -ne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'SHA-256 digest mismatch' }
    if (!$script:computed -or !$script:cleared) { throw 'Legacy SHA lifecycle not exercised' }
    # Ensure the input handle was released even on an old public API surface.
    $exclusive = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $exclusive.Close()
} finally { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } }
Write-Host 'PASS: SHA-256 with legacy public Clear()/no Dispose(), correct digest and released file handle'
