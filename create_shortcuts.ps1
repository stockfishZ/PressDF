# PowerShell script to create Desktop and Project shortcuts for PressDF

$projectRoot = "D:\Project\PressDF"
$exePath = Join-Path $projectRoot "dist\PressDF.exe"
$iconPath = Join-Path $projectRoot "pressdf.ico"
$desktopDir = [Environment]::GetFolderPath('Desktop')

if (-not (Test-Path $exePath)) {
    Write-Error "Target executable not found at: $exePath"
    exit 1
}

$ws = New-Object -ComObject WScript.Shell

# 1. Primary User Desktop Shortcut (Active Desktop)
$desktopShortcutPath = Join-Path $desktopDir "PressDF.lnk"
$desktopShortcut = $ws.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $exePath
$desktopShortcut.WorkingDirectory = $projectRoot
$desktopShortcut.Description = "PressDF - Precision Local PDF Compression Studio"
$desktopShortcut.IconLocation = "$iconPath,0"
$desktopShortcut.Save()
Write-Output "Created Active Desktop shortcut: $desktopShortcutPath"

# 1b. Fallback C:\Users\iwank\Desktop if directory exists
$userProfileDesktop = "C:\Users\iwank\Desktop"
if (Test-Path $userProfileDesktop) {
    $upShortcutPath = Join-Path $userProfileDesktop "PressDF.lnk"
    $upShortcut = $ws.CreateShortcut($upShortcutPath)
    $upShortcut.TargetPath = $exePath
    $upShortcut.WorkingDirectory = $projectRoot
    $upShortcut.Description = "PressDF - Precision Local PDF Compression Studio"
    $upShortcut.IconLocation = "$iconPath,0"
    $upShortcut.Save()
    Write-Output "Created C:\Users\iwank\Desktop shortcut: $upShortcutPath"
}

# 2. Project Root Shortcut
$projectShortcutPath = Join-Path $projectRoot "PressDF.lnk"
$projectShortcut = $ws.CreateShortcut($projectShortcutPath)
$projectShortcut.TargetPath = $exePath
$projectShortcut.WorkingDirectory = $projectRoot
$projectShortcut.Description = "PressDF - Precision Local PDF Compression Studio"
$projectShortcut.IconLocation = "$iconPath,0"
$projectShortcut.Save()
Write-Output "Created Project root shortcut: $projectShortcutPath"

# Verify shortcuts
Get-Item $desktopShortcutPath, $projectShortcutPath | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize
