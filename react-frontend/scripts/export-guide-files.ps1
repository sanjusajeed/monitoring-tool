$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$docsDir = Join-Path $repoRoot "docs"
$htmlPath = Join-Path $docsDir "Application_Monitor_User_Guide.html"
$docPath = Join-Path $docsDir "Application_Monitor_User_Guide.doc"
$pdfPath = Join-Path $docsDir "Application_Monitor_User_Guide.pdf"

Copy-Item -Path $htmlPath -Destination $docPath -Force

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$browser = if (Test-Path $edge) { $edge } elseif (Test-Path $chrome) { $chrome } else { $null }

if ($browser) {
  $fileUrl = "file:///" + ($htmlPath -replace "\\", "/" -replace " ", "%20")
  & $browser --headless=new --disable-gpu --no-sandbox "--print-to-pdf=$pdfPath" $fileUrl
} else {
  Write-Warning "Could not find Edge or Chrome. Created Word .doc file only."
}

Get-Item $docPath, $pdfPath -ErrorAction SilentlyContinue | Select-Object FullName, Length
