$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -TypeDefinition $request.implementation
    [AicoFileExchange]::Exchange($request.directory, $request.left, $request.right, $request.directoryId)
    [Console]::Out.WriteLine('{"ok":true}')
} catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    [Console]::Out.WriteLine((@{ok=$false;committed=($failure.Data['committed'] -eq $true);message=$failure.Message} | ConvertTo-Json -Compress))
    exit 1
}
