$rawToken = (Get-Content "$PSScriptRoot\last-invitation-token.txt" -Raw).Trim()

Write-Host "Token length: $($rawToken.Length)" -ForegroundColor Cyan

$signup = @{
  token     = $rawToken
  email     = "subagent4@example.com"
  password  = "Password1!"
  full_name = "Mary Njeri"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-sub-agent-signup" `
  -Method POST `
  -ContentType "application/json" `
  -Body $signup

$resp | ConvertTo-Json -Depth 10