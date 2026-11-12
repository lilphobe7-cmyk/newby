$rawToken = Get-Content "$PSScriptRoot\last-invitation-token.txt" -Raw

Write-Host "Resolving token: $rawToken" -ForegroundColor Cyan

$resolve = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-resolve?token=$rawToken" `
  -Method GET

$resolve | ConvertTo-Json -Depth 10