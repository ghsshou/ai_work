param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$paths=@()
foreach($p in @(Get-CimInstance Win32_Process)) {
  if($p.Name -in @('python.exe','profiler_server.exe') -and !$p.ExecutablePath){throw 'Cannot identify a native runtime process'}
  if($p.ExecutablePath -and $p.ExecutablePath.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)){$paths+=$p.ExecutablePath}
}
ConvertTo-Json -Compress -InputObject @($paths)

