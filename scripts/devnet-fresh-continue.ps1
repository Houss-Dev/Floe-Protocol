# Resume after devnet-fresh-start.ps1 stopped at faucet (build + keys already done).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Drive = "L:"
if ($Root -match " ") {
  if (-not (Test-Path "${Drive}\")) { subst $Drive $Root | Out-Null }
  $Work = $Drive
} else { $Work = $Root }
Set-Location $Work

$walletPath = Join-Path $Work "dev-wallet.json"
if (-not (Test-Path $walletPath)) { throw "Missing dev-wallet.json - run devnet-fresh-start.ps1 first" }
$walletForCli = if ($Work -eq "L:") { "L:\dev-wallet.json" } else { $walletPath }
$env:ANCHOR_WALLET = $walletForCli
$env:ANCHOR_PROVIDER_URL = "https://api.devnet.solana.com"
$operator = solana-keygen pubkey $walletForCli
solana config set --url devnet --keypair $walletForCli | Out-Null

$bal = (solana balance --url devnet).Trim()
Write-Host "Operator $operator balance: $bal"
if ($bal -match "^0(\.|$)") { throw "Wallet still unfunded. Send devnet SOL to $operator" }

Write-Host "==> anchor deploy"
anchor deploy --provider.cluster devnet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> devnet mints + bootstrap"
npm run devnet:mints
npm run devnet:bootstrap

$libRs = Get-Content (Join-Path $Work "programs\ledgerline\src\lib.rs") -Raw
if ($libRs -notmatch 'declare_id!\("([^"]+)"\)') { throw "declare_id! not found" }
$programId = $Matches[1]
@"
NEXT_PUBLIC_PROGRAM_ID=$programId
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
"@ | Set-Content -Encoding utf8 (Join-Path $Work "app\.env.local")

@"
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
PROGRAM_ID=$programId
ANCHOR_WALLET=$walletPath
HERMES_URL=https://hermes.pyth.network
"@ | Set-Content -Encoding utf8 (Join-Path $Work "keeper\.env")

Write-Host "Done. Program $programId Operator $operator"
