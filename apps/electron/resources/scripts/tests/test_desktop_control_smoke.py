from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "desktop-control.ps1"
POWERSHELL = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"


@unittest.skipUnless(os.name == "nt", "Windows desktop component")
class DesktopControlSmokeTests(unittest.TestCase):
    def run_powershell(self, body: str):
        result = subprocess.run(
            [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-Command", body],
            capture_output=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        def reject_constant(value):
            raise ValueError(f"Non-standard JSON number: {value}")

        return json.loads(result.stdout, parse_constant=reject_constant)

    def test_empty_nonfinite_and_zero_bounds_remain_standard_json(self):
        script_path = str(SCRIPT).replace("'", "''")
        result = self.run_powershell(f"""$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName WindowsBase
$tree = [System.Management.Automation.Language.Parser]::ParseFile('{script_path}', [ref]$null, [ref]$null)
$function = $tree.Find({{ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SnapshotBounds' }}, $true)
. ([scriptblock]::Create($function.Extent.Text))
$cases = @(
  [System.Windows.Rect]::Empty,
  [System.Windows.Rect]::new(-1200, -500, 300, 200),
  [System.Windows.Rect]::new(0, 0, 0, 20),
  [pscustomobject]@{{ IsEmpty = $false; X = [double]::NaN; Y = 0; Width = 20; Height = 20 }},
  [pscustomobject]@{{ IsEmpty = $false; X = 0; Y = 0; Width = [double]::PositiveInfinity; Height = 20 }},
  $null
)
@($cases | ForEach-Object {{ Get-SnapshotBounds $_ }}) | ConvertTo-Json -Compress
""")
        self.assertEqual(len(result), 6)
        self.assertEqual(result[1], {
            "boundsAvailable": True, "x": -1200, "y": -500, "width": 300, "height": 200,
        })
        for index in (0, 2, 3, 4, 5):
            self.assertFalse(result[index]["boundsAvailable"])
            for coordinate in ("x", "y", "width", "height"):
                self.assertIsNone(result[index][coordinate])

    def test_minimized_window_snapshot_returns_restore_guidance(self):
        script_path = str(SCRIPT).replace("'", "''")
        result = self.run_powershell(f"""$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$requestPath = [System.IO.Path]::GetTempFileName()
try {{
  $form.Text = 'TokenBird desktop regression test'
  $form.ShowInTaskbar = $false
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  @{{ action = 'snapshot'; windowId = $form.Handle.ToInt64().ToString(); limit = 5 }} | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
  & '{script_path}' -RequestPath $requestPath
}} finally {{
  $form.Dispose()
  Remove-Item -LiteralPath $requestPath -Force
}}
""")
        self.assertTrue(result["minimized"])
        self.assertEqual(result["elements"], [])
        self.assertFalse(result["truncated"])
        self.assertIn("focus", result["message"])


if __name__ == "__main__":
    unittest.main()
