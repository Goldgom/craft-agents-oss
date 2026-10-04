import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { isPowerShellAvailable, setPowerShellValidatorRoot } from '../../powershell-validator.ts';
import { isReadOnlySystemInspection } from '../system-inspection-policy.ts';

setPowerShellValidatorRoot(join(import.meta.dir, '..', '..'));

describe('automatic system inspection', () => {
  test('uses the complete Bash AST and permits only system metadata commands', () => {
    for (const command of ['uname -a', 'hostname -f', 'whoami', 'pwd', 'id -u', 'df -h', 'uname -a && df -h', 'lsblk -J', 'lscpu --json']) {
      expect(isReadOnlySystemInspection(command)).toBe(true);
    }
    for (const command of ['hostname changed-host', 'cat /etc/passwd', 'ls /outside', 'df -h > output', 'df -h; rm -rf output',
      'df -h | sh', 'uname $(touch output)', 'df -h &', 'PATH=bad df -h', 'printf \'fake\'', 'df -h < /etc/passwd']) {
      expect(isReadOnlySystemInspection(command)).toBe(false);
    }
  });

  test.skipIf(!isPowerShellAvailable())('parses real PowerShell metadata objects and local bindings without granting arbitrary PowerShell execution', () => {
    const metadata = `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";[pscustomobject]@{ComputerName=$env:COMPUTERNAME;UserName=$env:USERNAME;OSVersion=[Environment]::OSVersion.VersionString;SystemDrive=$env:SystemDrive;UserTemp=$env:TEMP;WindowsTemp=(Join-Path $env:windir 'Temp');Drive=$d.DeviceID;SizeBytes=$d.Size;FreeBytes=$d.FreeSpace} | ConvertTo-Json -Compress`;
    for (const command of ['Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress',
      '$PSVersionTable.PSVersion; $env:COMPUTERNAME; [System.Environment]::MachineName', metadata,
      `powershell.exe -NoProfile -NonInteractive -Command "Get-PSDrive | ConvertTo-Json -Compress"`]) {
      expect(isReadOnlySystemInspection(command)).toBe(true);
    }
    expect(isReadOnlySystemInspection(`powershell.exe -NoProfile -Command "$d=Get-CimInstance Win32_LogicalDisk; [pscustomobject]@{Name=$env:COMPUTERNAME;Free=$d.FreeSpace}|ConvertTo-Json -Compress"`, 'cmd')).toBe(true);
    expect(isReadOnlySystemInspection(`powershell.exe -NoProfile -Command "$d=Get-CimInstance Win32_LogicalDisk; $d"`, 'posix')).toBe(false);
    expect(isReadOnlySystemInspection(`powershell.exe -NoProfile -Command 'Get-PSDrive | ConvertTo-Json -Compress'`, 'posix')).toBe(true);
    for (const command of [`powershell.exe -NoProfile -Command "Get-Date" & del file`, `powershell.exe -NoProfile -Command "Get-Date; %DANGER%"`,
      `powershell.exe -NoProfile -Command "Get-Date; !DANGER!"`, `powershell.exe -NoProfile -Command "Get-Date \\" & del file & \\""`]) {
      expect(isReadOnlySystemInspection(command, 'cmd')).toBe(false);
    }
    for (const command of ['Get-Content C:\\outside\\secret.txt', 'Get-Date; Remove-Item file', 'Get-PSDrive | Out-File file',
      '[System.IO.File]::Delete("file")', 'Get-Date ([System.IO.File]::Delete("file"))', '[System.Environment]::SetEnvironmentVariable("x","y")',
      'Get-Process | ForEach-Object { Stop-Process $_ }', '$d=Get-Content file; $d', '$env:PATH="changed"; Get-Date',
      '$d=Get-Date; $d.AddSeconds(1)', '$d=[System.IO.File]::ReadAllText("file"); $d',
      `powershell.exe -NoProfile -Command 'Get-PSDrive' && rm file`, `powershell.exe -Command 'Get-Date'`,
      `powershell.exe -NoProfile -EncodedCommand anything`, 'Get-CimInstance StdRegProv']) {
      expect(isReadOnlySystemInspection(command)).toBe(false);
    }
  }, 30_000);
});
