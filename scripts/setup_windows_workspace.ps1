<#
One-click Windows workspace setup for the smart e-paper backend and ESP32-S3 firmware.

Core toolchain:
- Git: https://git-scm.com/download/win
- Node.js LTS: https://nodejs.org/en/download
- Python 3.11: https://www.python.org/downloads/windows/
- PlatformIO: https://platformio.org/install
- ESP-IDF 4.4.7 is installed by PlatformIO through espressif32@6.5.0.
  ESP-IDF release link: https://github.com/espressif/esp-idf/releases/tag/v4.4.7

Typical use:
  powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows_workspace.ps1

Preview only:
  powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows_workspace.ps1 -DryRun
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$BackendRoot = "",
    [string]$FirmwareRoot = "D:\idfchonggouepd",
    [switch]$SkipPackageInstall,
    [switch]$RunBuildChecks
)

$ErrorActionPreference = "Stop"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($BackendRoot)) {
    $BackendRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
}

$FirmwareEnv = "4d_systems_esp32s3_gen4_r8n16"
$PublicOrigin = "https://epd.gaoshanliuni.top:19999"
$BackendPortLine = "PORT=8890"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $line = "$FilePath $($ArgumentList -join ' ')"
    if ($DryRun) {
        Write-Host "[dry-run] ($WorkingDirectory) $line"
        return
    }

    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code ${LASTEXITCODE}: $line"
        }
    } finally {
        Pop-Location
    }
}

function Show-ManualDownloadLinks {
    Write-Host "Manual download links if winget is unavailable:"
    Write-Host "  Git: https://git-scm.com/download/win"
    Write-Host "  Node.js LTS: https://nodejs.org/en/download"
    Write-Host "  Python 3.11: https://www.python.org/downloads/windows/"
    Write-Host "  PlatformIO: https://platformio.org/install"
    Write-Host "  ESP-IDF 4.4.7: https://github.com/espressif/esp-idf/releases/tag/v4.4.7"
}

function Install-WithWinget {
    param(
        [string]$PackageId,
        [string]$DisplayName
    )

    if (-not (Test-Command "winget")) {
        Write-Warning "winget not found; please install $DisplayName manually."
        Show-ManualDownloadLinks
        return
    }

    Invoke-External "winget" @(
        "install",
        "--id", $PackageId,
        "-e",
        "--source", "winget",
        "--accept-package-agreements",
        "--accept-source-agreements"
    )
}

function Ensure-Tool {
    param(
        [string]$CommandName,
        [string]$PackageId,
        [string]$DisplayName
    )

    if (Test-Command $CommandName) {
        Write-Host "$DisplayName already available: $CommandName"
        return
    }

    Write-Host "$DisplayName not found. Installing with winget..."
    Install-WithWinget -PackageId $PackageId -DisplayName $DisplayName
}

function Get-PythonInvocation {
    if (Test-Command "py") {
        return @{ Exe = "py"; Prefix = @("-3.11") }
    }
    if (Test-Command "python") {
        return @{ Exe = "python"; Prefix = @() }
    }
    return $null
}

function Invoke-Python {
    param([string[]]$Arguments)

    $python = Get-PythonInvocation
    if ($null -eq $python) {
        throw "Python 3.11 was not found. Install it and re-run this script."
    }
    Invoke-External $python.Exe ($python.Prefix + $Arguments)
}

function Set-UserEnv {
    param(
        [string]$Name,
        [string]$Value
    )

    if ($DryRun) {
        Write-Host "[dry-run] set user env $Name=$Value"
        return
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, "User")
    Set-Item -Path "Env:$Name" -Value $Value
    Write-Host "set user env $Name=$Value"
}

function Add-UserPath {
    param([string]$PathToAdd)

    if ([string]::IsNullOrWhiteSpace($PathToAdd)) {
        return
    }

    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        $parts = $current -split ";"
    }
    if ($parts -contains $PathToAdd) {
        return
    }

    if ($DryRun) {
        Write-Host "[dry-run] add user PATH: $PathToAdd"
        return
    }

    $next = (($parts + $PathToAdd) | Where-Object { $_ -and $_.Trim() }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
    $env:Path = "$env:Path;$PathToAdd"
    Write-Host "added user PATH: $PathToAdd"
}

Write-Section "Workspace"
Write-Host "Backend/Web root: $BackendRoot"
Write-Host "Firmware root:    $FirmwareRoot"
Write-Host "Public origin:    $PublicOrigin"
Write-Host "Backend default:  $BackendPortLine"

Write-Section "Install base tools"
Ensure-Tool -CommandName "git" -PackageId "Git.Git" -DisplayName "Git"
Ensure-Tool -CommandName "node" -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
Ensure-Tool -CommandName "python" -PackageId "Python.Python.3.11" -DisplayName "Python 3.11"

Write-Section "Python and PlatformIO"
Invoke-Python @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Python @("-m", "pip", "install", "--user", "--upgrade", "platformio")

if (-not $DryRun) {
    $python = Get-PythonInvocation
    $userBase = (& $python.Exe @($python.Prefix + @("-m", "site", "--user-base"))).Trim()
    Add-UserPath (Join-Path $userBase "Scripts")
}

Write-Section "Project environment variables"
$playwrightPath = Join-Path $BackendRoot "backend\.local-browser"
$ocrPython = Join-Path $BackendRoot "backend\.venv\Scripts\python.exe"
Set-UserEnv "PORT" "8890"
Set-UserEnv "PUBLIC_ORIGIN" $PublicOrigin
Set-UserEnv "TRUST_PROXY" "1"
Set-UserEnv "FORCE_HTTPS" "0"
Set-UserEnv "PLAYWRIGHT_BROWSERS_PATH" $playwrightPath
Set-UserEnv "XIQUE_OCR_PYTHON_BIN" $ocrPython
Set-UserEnv "XIQUE_OCR_ENABLED" "1"

if (-not $SkipPackageInstall) {
    Write-Section "Backend dependencies"
    $backendDir = Join-Path $BackendRoot "backend"
    if (Test-Path $backendDir) {
        Invoke-External "npm" @("install") $backendDir
        Invoke-External "npx" @("playwright", "install", "chromium") $backendDir

        $venvDir = Join-Path $backendDir ".venv"
        if (-not (Test-Path $venvDir)) {
            Invoke-Python @("-m", "venv", $venvDir)
        }
        $venvPython = Join-Path $venvDir "Scripts\python.exe"
        $ocrRequirements = Join-Path $backendDir "tools\ocr\requirements.txt"
        if (Test-Path $ocrRequirements) {
            Invoke-External $venvPython @("-m", "pip", "install", "--upgrade", "pip") $backendDir
            Invoke-External $venvPython @("-m", "pip", "install", "-r", $ocrRequirements) $backendDir
        }
    } else {
        Write-Warning "Backend directory not found: $backendDir"
    }

    Write-Section "Frontend dependencies"
    $frontendDir = Join-Path $BackendRoot "frontend-vue"
    if (Test-Path $frontendDir) {
        Invoke-External "npm" @("install") $frontendDir
    } else {
        Write-Warning "Frontend directory not found: $frontendDir"
    }
}

Write-Section "Firmware toolchain"
if (Test-Path $FirmwareRoot) {
    Write-Host "PlatformIO project uses espressif32@6.5.0 and ESP-IDF 4.4.7 via platformio/framework-espidf@~3.40407.0."
    Write-Host "Build check command: pio run -e 4d_systems_esp32s3_gen4_r8n16"
    if ($RunBuildChecks) {
        Invoke-External "pio" @("run", "-e", $FirmwareEnv) $FirmwareRoot
    }
} else {
    Write-Warning "Firmware directory not found: $FirmwareRoot"
}

Write-Section "Optional validation"
Write-Host "Backend start: cd $BackendRoot\backend; npm run start"
Write-Host "Frontend dev:  cd $BackendRoot\frontend-vue; npm run dev"
Write-Host "Firmware:      cd $FirmwareRoot; pio run -e 4d_systems_esp32s3_gen4_r8n16"
Write-Host "Firmware pack: cd $FirmwareRoot; python tools\build_firmware_variants.py"
Write-Host "Done."
