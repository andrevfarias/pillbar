#Requires -Version 7.3
<#
.SYNOPSIS
Regenera as imagens do README (docs/*.png) com o código atual do pillbar.

.DESCRIPTION
Copia o mod para uma pasta temporária com o shots.ts no lugar dos testes, roda o
claude plugin test para montar as cenas e desenha os PNGs com o render.py, num venv
com o requirements.txt. Precisa do claude e do Python 3 no PATH e da FiraCode Nerd
Font Mono instalada para o usuário.
#>

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repoRoot = Split-Path (Split-Path $PSScriptRoot)
$workDir = Join-Path ([IO.Path]::GetTempPath()) "pillbar-shots-$PID"
$modCopy = Join-Path $workDir 'mod'
$sceneFile = Join-Path $workDir 'shots.txt'
$venvDir = Join-Path $workDir 'venv'

try {
    # O mod sem os testes dele: o plugin test roda só as cenas.
    New-Item -ItemType Directory (Join-Path $modCopy 'tests') | Out-Null
    Get-ChildItem $repoRoot -Force -Exclude '.git', 'docs', 'tests' | Copy-Item -Destination $modCopy -Recurse
    Copy-Item (Join-Path $PSScriptRoot 'shots.ts') (Join-Path $modCopy 'tests/shots.test.ts')

    # O console.log dos testes sai no stderr: cada cena numa linha que começa com SHOT,
    # com os ícones da Nerd Font em UTF-8.
    $consoleEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    try {
        $sceneLines = @(claude plugin test $modCopy 2>&1 | ForEach-Object { "$_" } | Where-Object { $_.StartsWith('SHOT ') })
    }
    finally {
        [Console]::OutputEncoding = $consoleEncoding
    }
    Set-Content $sceneFile $sceneLines -Encoding utf8NoBOM
    Write-Host "cenas: $($sceneLines.Count)"

    python -m venv $venvDir
    $venvPython = Join-Path $venvDir 'Scripts/python.exe'
    & $venvPython -m pip install --quiet --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements.txt')
    & $venvPython (Join-Path $PSScriptRoot 'render.py') $sceneFile (Join-Path $repoRoot 'docs')
}
finally {
    Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
