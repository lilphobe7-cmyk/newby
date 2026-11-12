. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = "subagent1@example.com"
  password = "Password1"
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$subToken = $auth.access_token
Write-Host "Logged in as subagent1" -ForegroundColor Green

try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-create" `
    -Method POST -Headers @{ Authorization = "Bearer $subToken" } `
    -ContentType "application/json" `
    -Body (@{ workspace_id = $MAINAGENT1_WORKSPACE } | ConvertTo-Json)

  Write-Host "ERROR: Sub-agent was allowed to create an invitation!" -ForegroundColor Red
} catch {
  Write-Host "Correctly blocked" -ForegroundColor Green
  Write-Host "Status: $($_.Exception.Response.StatusCode.value__)"
  $stream = $_.Exception.Response.GetResponseStream()
  $reader = New-Object System.IO.StreamReader($stream)
  $body = $reader.ReadToEnd()
  Write-Host "Body: $body"
}