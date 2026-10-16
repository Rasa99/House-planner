<#
    dev/dxf-acad.ps1  (drafting agent, House Planner)

    OPENs a House Planner DXF in AutoCAD 2027's headless engine (the way Rasa
    opens it), runs AUDIT, prints what AutoCAD itself holds (dev/dxf-acad.lsp
    does the reading) and, with -PngFile, has AutoCAD plot it to a PNG.

      powershell -ExecutionPolicy Bypass -File dev\dxf-acad.ps1 -DxfFile <plan.dxf> [-PngFile <out.png>]

    If <plan>.summary.json (written by dev/dxf-export.js) is next to the DXF,
    AutoCAD's entity counts and hatch areas are compared with the drawing's.

    Goes through "AutoCAD Tools\Run-Headless.ps1" ON PURPOSE: calling
    accoreconsole.exe directly writes OSMODE / SECURELOAD into Rasa's real
    AutoCAD profile; the wrapper puts them back. It is started from a scratch
    folder because accoreconsole leaves an ErrorReports\ folder in the folder it
    starts from. Exit code 0 only if AUDIT found 0 errors and every check held.
#>
param(
    [Parameter(Mandatory = $true)][string]$DxfFile,
    [string]$PngFile,
    [int]$Seconds = 300
)
$ErrorActionPreference = 'Stop'
$runner = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\AutoCAD Tools\Run-Headless.ps1')).Path
$work = Join-Path $env:TEMP 'houseplan-acad'
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'dxf-acad.lsp') (Join-Path $work 'dxf-acad.lsp') -Force
Copy-Item -LiteralPath $DxfFile (Join-Path $work 'plan.dxf') -Force
$lsp = (Join-Path $work 'dxf-acad.lsp') -replace '\\', '/'
$dxfIn = (Join-Path $work 'plan.dxf') -replace '\\', '/'
$plotOut = (Join-Path $work 'plot.png') -replace '\\', '/'
if (Test-Path ($plotOut -replace '/', '\')) { Remove-Item ($plotOut -replace '/', '\') -Force }

# one command or answer per line, never a blank line (a blank line is an Enter)
$s = @('FILEDIA 0', "_.OPEN $dxfIn", "(load `"$lsp`")", '(hp:check nil)')
if ($PngFile) {
    # -PLOT prompts as AutoCAD 2027 asks them (read from a run on 2026-10-15)
    $s += @('_.ZOOM _E', '_.-PLOT', '_Y', 'Model', 'PublishToWeb PNG.pc3', '8K UHD (7680.00 x 4320.00 Pixels)',
        '_L', '_N', '_E', '_F', '_C', '_Y', '.', '_Y', '_A', $plotOut, '_N', '_Y')
}
$s += '_.QUIT _Y'
$scr = Join-Path $work 'run.scr'
$s | Set-Content $scr -Encoding ascii

Push-Location $work
try { $all = & powershell -ExecutionPolicy Bypass -File $runner -Script $scr -TimeoutSeconds $Seconds | Out-String }
finally { Pop-Location }
Set-Content (Join-Path $work 'last-run.txt') $all -Encoding utf8

$lines = $all -split "`r?`n"
$inAudit = $false
foreach ($l in $lines) {
    if ($l -match 'HPSTEP audit') { $inAudit = $true; continue }
    if ($l -match 'HPSTEP report') { $inAudit = $false }
    if ($inAudit -and $l.Trim()) { Write-Host ('AUDIT| ' + $l.Trim()) }
    elseif ($l -match '^\s*HP' -and $l -notmatch '^\s*HPDIM ') { Write-Host $l.Trim() }
}
$dimLines = @($lines | Where-Object { $_ -match '^\s*HPDIM ' })
Write-Host ("HPDIM x" + $dimLines.Count + " (first 3 shown)")
$dimLines | Select-Object -First 3 | ForEach-Object { Write-Host $_.Trim() }

$fails = @()
if ($all -notmatch 'Total errors found 0 fixed 0') { $fails += 'AUDIT did not report 0 errors' }
if ($all -notmatch 'HPDONE') { $fails += 'the report did not finish' }
if ($all -match 'MISSING') { $fails += 'something is MISSING' }
if ($all -notmatch 'HPSTEP opened') { $fails += 'the DXF was not opened' }

# ---- compare with the drawing's own numbers
$summaryPath = [IO.Path]::ChangeExtension($DxfFile, $null).TrimEnd('.') + '.summary.json'
if (Test-Path -LiteralPath $summaryPath) {
    $sum = Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $count = @{}
    $m = [regex]::Matches(($lines | Where-Object { $_ -match '^\s*HPCOUNT' } | Select-Object -First 1), '"(\w+)" \. (\d+)')
    foreach ($x in $m) { $count[$x.Groups[1].Value] = [int]$x.Groups[2].Value }
    foreach ($p in $sum.entities.PSObject.Properties) {
        $got = if ($count.ContainsKey($p.Name)) { $count[$p.Name] } else { 0 }
        if ($got -ne [int]$p.Value) { $fails += "AutoCAD holds $got $($p.Name), the drawing has $($p.Value)" }
    }
    foreach ($k in $count.Keys) { if (-not $sum.entities.PSObject.Properties[$k]) { $fails += "AutoCAD holds $($count[$k]) $k the drawing does not have" } }
    $acadAreas = @($lines | Where-Object { $_ -match '^\s*HPHATCH' } | ForEach-Object { [double]([regex]::Match($_, 'area=([\d.]+)').Groups[1].Value) } | Sort-Object)
    $unit = @{ m = 1.0; cm = 100.0; mm = 1000.0 }[[string]$sum.units]
    if (-not $unit) { $unit = 1.0 }
    $ourAreas = @($sum.hatches | ForEach-Object { [double]$_.area * $unit * $unit } | Sort-Object)   # drawing areas are m2
    $bad = 0
    for ($i = 0; $i -lt [Math]::Max($acadAreas.Count, $ourAreas.Count); $i++) {
        if ($i -ge $acadAreas.Count -or $i -ge $ourAreas.Count -or [Math]::Abs($acadAreas[$i] - $ourAreas[$i]) -gt 1e-4 * [Math]::Max(1, $ourAreas[$i])) { $bad++ }
    }
    if ($bad) { $fails += "hatch areas differ: AutoCAD $($acadAreas -join ', ') / drawing $($ourAreas -join ', ')" }
    else { Write-Host ("HPAREAS AutoCAD's hatch areas equal the drawing's: " + ($ourAreas -join ', ')) }
    Write-Host ("HPCOMPARE entity counts " + $(if ($fails | Where-Object { $_ -match 'holds' }) { 'DIFFER' } else { 'equal the drawing: ' + (($sum.entities.PSObject.Properties | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', ') }))
}

if ($PngFile) {
    $png = $plotOut -replace '/', '\'
    if (Test-Path $png) { Copy-Item $png $PngFile -Force; Write-Host "HPPLOT AutoCAD plotted $PngFile" }
    else { $fails += 'AutoCAD did not plot the PNG' }
}
if (-not $fails) { Write-Host 'AutoCAD: AUDIT 0 errors, every check held.'; exit 0 }
$fails | ForEach-Object { Write-Host "FAIL: $_" }
Write-Host "AutoCAD check FAILED (whole transcript: $work\last-run.txt)"
exit 1
