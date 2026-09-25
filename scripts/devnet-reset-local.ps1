# Remove local devnet artifacts only (no on-chain deletes). Safe before a fresh bring-up.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> Removing local wallets, mint keypairs, anchor cache, demo devnet state"

$paths = @(
  (Join-Path $Root "dev-wallet.json"),
  (Join-Path $Root "keeper-wallet.json"),
  (Join-Path $Root "keeper\.env"),
  (Join-Path $Root ".anchor"),
  (Join-Path $Root "target\mints"),
  (Join-Path $Root "target\deploy\ledgerline-keypair.json")
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Remove-Item -Recurse -Force $p
    Write-Host "  removed $p"
  }
}

$stateDevnet = Join-Path $Root "demo\state.devnet.json"
$example = Join-Path $Root "demo\state.example.json"
if (Test-Path $example) {
  $ex = Get-Content $example -Raw | ConvertFrom-Json
  $fresh = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    network     = "https://api.devnet.solana.com"
    programId   = ""
    keeper      = ""
    lines       = @()
    recentActions = @()
  }
  ($fresh | ConvertTo-Json -Depth 6) | Set-Content -Encoding utf8 $stateDevnet
  Write-Host "  reset demo/state.devnet.json"
}

Write-Host "Done. Run scripts/devnet-fresh-start.ps1 to generate keys, deploy, mints, and bootstrap."
