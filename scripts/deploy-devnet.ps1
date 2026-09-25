# Windows devnet deploy (path must not break SBF build — use SUBST if the repo path has spaces).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Drive = "L:"
if (-not (Test-Path "${Drive}\")) {
  subst $Drive $Root
}
Set-Location $Drive
$env:HOME = $env:USERPROFILE
$env:CARGO_TARGET_DIR = "${Drive}\target"

Write-Host "==> anchor build"
anchor build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> balance (need ~3.1 SOL on devnet for upgrade)"
solana balance

$LibRs = Get-Content "${Drive}\programs\ledgerline\src\lib.rs" -Raw
if ($LibRs -notmatch 'declare_id!\("([^"]+)"\)') { throw "declare_id! not found in lib.rs" }
$ProgramId = $Matches[1]
Write-Host "==> solana program deploy (program-id $ProgramId from declare_id!)"
solana program deploy "${Drive}\target\deploy\ledgerline.so" --program-id $ProgramId --url devnet
exit $LASTEXITCODE
