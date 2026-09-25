# Fresh devnet: new operator wallet + new program keypair, deploy, mock mints, bootstrap.
# Uses SUBST L: when repo path contains spaces (SBF build requirement).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Drive = "L:"
if ($Root -match " ") {
  if (-not (Test-Path "${Drive}\")) { subst $Drive $Root | Out-Null }
  $Work = $Drive
} else {
  $Work = $Root
}
Set-Location $Work
$env:HOME = $env:USERPROFILE
$env:CARGO_TARGET_DIR = Join-Path $Work "target"
$env:ANCHOR_PROVIDER_URL = "https://api.devnet.solana.com"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name not found. Run scripts/bootstrap.sh or install Agave + Anchor 0.32.2."
  }
}

Require-Cmd solana-keygen
Require-Cmd solana
Require-Cmd anchor
Require-Cmd node

& (Join-Path $Root "scripts\devnet-reset-local.ps1")

$walletPath = Join-Path $Work "dev-wallet.json"
$programKp = Join-Path $Work "target\deploy\ledgerline-keypair.json"
New-Item -ItemType Directory -Force -Path (Split-Path $programKp) | Out-Null

Write-Host "==> New operator wallet (dev-wallet.json)"
solana-keygen new -o $walletPath --no-bip39-passphrase -f | Out-Null
$operator = solana-keygen pubkey $walletPath
Write-Host "    operator: $operator"

Write-Host "==> New program keypair (target/deploy/ledgerline-keypair.json)"
solana-keygen new -o $programKp --no-bip39-passphrase -f | Out-Null
$programId = solana-keygen pubkey $programKp
Write-Host "    programId: $programId"

$env:ANCHOR_WALLET = $walletPath
solana config set --url devnet --keypair $walletPath | Out-Null

Write-Host "==> anchor keys sync"
Push-Location $Work
anchor keys sync
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "==> anchor build"
anchor build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

$idlSrc = Join-Path $Work "target\idl\ledgerline.json"
$idlDst = Join-Path $Work "idl\ledgerline.json"
Copy-Item -Force $idlSrc $idlDst
Copy-Item -Force $idlSrc (Join-Path $Work "app\public\idl\ledgerline.json")
Copy-Item -Force $idlSrc (Join-Path $Work ".github\ledgerline.idl.json")

Write-Host "==> generate TS client"
npm run generate:client --silent
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "==> devnet airdrop (faucet may rate-limit; retrying)"
$ErrorActionPreference = "Continue"
for ($i = 1; $i -le 8; $i++) {
  solana airdrop 1 $operator --url devnet 2>$null | Out-Null
  Start-Sleep -Seconds 4
  $bal = (solana balance --url devnet 2>$null).Trim()
  Write-Host "    attempt $i balance: $bal"
  if ($bal -and $bal -notmatch "^0(\.|$| SOL)") { break }
}
$ErrorActionPreference = "Stop"
$balFinal = (solana balance --url devnet).Trim()
if ($balFinal -match "^0(\.|$)") {
  Write-Host "Faucet empty. Fund dev-wallet.json manually, then run:"
  Write-Host "  `$env:ANCHOR_WALLET='$walletPath'; anchor deploy --provider.cluster devnet"
  Write-Host "  npm run devnet:mints; npm run devnet:bootstrap"
  Pop-Location
  exit 2
}

Write-Host "==> anchor deploy (devnet)"
anchor deploy --provider.cluster devnet
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "==> mock mints + devnet-mints.ts"
npm run devnet:mints
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

Write-Host "==> on-chain bootstrap (config, asset, line, reserve fund)"
npm run devnet:bootstrap
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }

$envFile = Join-Path $Work "app\.env.local"
@"
NEXT_PUBLIC_PROGRAM_ID=$programId
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
"@ | Set-Content -Encoding utf8 $envFile

$keeperEnv = Join-Path $Work "keeper\.env"
@"
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
PROGRAM_ID=$programId
ANCHOR_WALLET=$walletPath
HERMES_URL=https://hermes.pyth.network
"@ | Set-Content -Encoding utf8 $keeperEnv

$configDevnet = Join-Path $Work "keeper\config.devnet.json"
$cfg = Get-Content $configDevnet -Raw | ConvertFrom-Json
$cfg.programId = $programId
$mintsTs = Get-Content (Join-Path $Work "app\lib\devnet-mints.ts") -Raw
if ($mintsTs -match 'stockMint:\s*"(\w+)"') { $cfg.assets[0].mint = $Matches[1] }
$cfg | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $configDevnet

$statePath = Join-Path $Work "demo\state.devnet.json"
$st = @{
  generatedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  network       = "https://api.devnet.solana.com"
  programId     = $programId
  keeper        = $operator
  lines         = @()
  recentActions = @()
} | ConvertTo-Json -Depth 4
$st | Set-Content -Encoding utf8 $statePath

Pop-Location

Write-Host ""
Write-Host "=== Fresh devnet ready ==="
Write-Host "  Program ID:  $programId"
Write-Host "  Operator:    $operator  (admin + keeper + upgrade authority)"
Write-Host "  Wallet file: $walletPath  (gitignored - back up offline; never commit)"
Write-Host "  App:         cd app; npm run dev"
Write-Host "  Keeper:      cd keeper; npm run keeper:once"
Write-Host ""
