param(
  [Parameter(Mandatory = $true)]
  [string]$Checkout
)

$ErrorActionPreference = 'Stop'

& git -C $Checkout pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& pnpm --dir $Checkout install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& pnpm --dir $Checkout build
exit $LASTEXITCODE
