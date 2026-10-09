$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$devShellRoot = Join-Path $repositoryRoot "tools/dev-shell"
$launcherPath = Join-Path $devShellRoot "AICO-PPT Dev Shell.cmd"
$iconPath = Join-Path $repositoryRoot "assets/launcher/aico-ppt-editor.ico"
$shortcutPath = Join-Path $devShellRoot "AICO-PPT Dev Shell（Windows）.lnk"

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "无法创建 Windows 快捷方式：找不到 AICO-PPT Dev Shell.cmd。"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "无法创建 Windows 快捷方式：找不到应用图标。"
}

$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.WorkingDirectory = $repositoryRoot
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = "AICO-PPT Dev Shell（仅供开发调试）"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
} finally {
    if ($null -ne $shell) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

Write-Output $shortcutPath
