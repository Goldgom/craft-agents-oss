import { parse } from 'shell-quote';
import { validateBashCommand } from '../bash-validator.ts';
import { isPowerShellAvailable, looksLikePowerShell, validatePowerShellCommand } from '../powershell-validator.ts';
import type { CompiledBashPattern } from '../mode-types.ts';

// These patterns constrain individual commands only after the full shell AST
// rejects writes, expansions, redirects, background jobs and injected commands.
// Filesystem readers are intentionally absent: their paths still need approval.
const patterns = (sources: string[]): CompiledBashPattern[] => sources.map(source => ({ source, regex: new RegExp(source, 'i') }));
const bashPatterns = patterns([
  '^uname(?:\\s+(?:-[amnrspvio]+|--(?:all|kernel-name|nodename|kernel-release|kernel-version|machine|processor|hardware-platform|operating-system|help|version)))*$',
  '^hostname(?:\\s+(?:-[fsdiI]|--(?:fqdn|short|domain|ip-address|all-ip-addresses|help|version)))*$',
  '^whoami(?:\\s+--(?:help|version))*$',
  '^pwd(?:\\s+-[LP])?$',
  '^id(?:\\s+(?:-[ugGnrz]+|--(?:user|group|groups|name|real|zero|help|version)))*$',
  '^df(?:\\s+(?:-[ahHiklmPT]+|--(?:human-readable|si|inodes|local|portability|print-type|total|help|version|output(?:=[a-z,]+)?)))*$',
  '^uptime(?:\\s+(?:-[ps]|--(?:pretty|since|help|version)))*$',
  '^free(?:\\s+(?:-[bkmghwt]|--(?:bytes|kibi|mebi|gibi|human|wide|total|help|version)))*$',
  '^lsblk(?:\\s+(?:-[abdfJlmnpP]+|--(?:all|bytes|fs|json|list|paths|pairs|help|version)))*$',
  '^lscpu(?:\\s+(?:-[J]|--(?:json|help|version)))*$',
]);
const powerShellPatterns = patterns([
  '^Get-(?:ComputerInfo|PSDrive|Volume|Disk|Partition|StoragePool|PhysicalDisk|Process|Host|Date)(?:\\s|$)',
  '^Get-(?:CimInstance|WmiObject)\\s+(?:-Class(?:Name)?\\s+)?Win32_(?:LogicalDisk|OperatingSystem|ComputerSystem|Processor|DiskDrive|DiskPartition|Volume|PhysicalMemory)(?:\\s|$)',
  '^(?:Select-Object|Format-List|Format-Table|ConvertTo-Json|ConvertTo-Csv|Sort-Object|Measure-Object)(?:\\s|$)',
  '^Join-Path(?:\\s|$)',
]);
const wrapperPatterns = patterns(['^(?:powershell|pwsh)(?:\\.exe)?\\s']);
const cache = new Map<string, boolean>();

/** A literal cmd.exe wrapper; the complete payload is still checked by the PS AST. */
function literalCmdPowerShellPayload(command: string): string | undefined {
  // cmd expands these characters even inside quoted arguments. Nested quotes
  // and escapes need a separate approval instead of guessing their semantics.
  if (/[\r\n%!^]/.test(command)) return;
  const match = command.match(/^(?:powershell|pwsh)(?:\.exe)?\s+((?:-(?:NoProfile|NonInteractive|NoLogo)\s+)+)-Command\s+"([^\"]*)"\s*$/i);
  if (!match || !/-NoProfile\s/i.test(match[1]!)) return;
  return match[2];
}

/** Only immutable machine/disk metadata, with no general shell or filesystem grant. */
export function isReadOnlySystemInspection(command: string, shell: 'posix' | 'cmd' = process.platform === 'win32' ? 'cmd' : 'posix'): boolean {
  if (typeof command !== 'string' || !command.trim() || command.length > 32_000 || command.includes('\0')) return false;
  const cacheKey = shell + ':' + command;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  let allowed = false;
  try {
    if (validateBashCommand(command, bashPatterns, { forbidRedirections: true }).allowed) allowed = true;
    else {
      const tokens = parse(command, variable => '$' + variable);
      const powerShellWrapper = typeof tokens[0] === 'string' && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(tokens[0]);
      let inner: string | undefined;
      if (powerShellWrapper && shell === 'cmd') inner = literalCmdPowerShellPayload(command);
      else if (powerShellWrapper) {
        // Reject outer shell injection before interpreting the quoted -Command.
        if (validateBashCommand(command, wrapperPatterns, { forbidRedirections: true }).allowed && tokens.every(token => typeof token === 'string')) {
          const args = tokens as string[], commandIndex = args.findIndex(arg => /^-Command$/i.test(arg));
          const flags = args.slice(1, commandIndex);
          if (commandIndex > 1 && commandIndex === args.length - 2
            && flags.every(flag => /^-(?:NoProfile|NonInteractive|NoLogo)$/i.test(flag))
            && flags.some(flag => /^-NoProfile$/i.test(flag))) inner = args.at(-1);
        }
      } else if (looksLikePowerShell(command) || /^\s*(?:\$|\[)/.test(command)) inner = command;
      if (inner && isPowerShellAvailable()) allowed = validatePowerShellCommand(inner, powerShellPatterns, { strictSystemInspection: true }).allowed;
    }
  } catch { /* If a native parser is unavailable, keep the scoped approval path. */ }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, allowed);
  return allowed;
}
