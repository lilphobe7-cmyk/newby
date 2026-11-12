. "$PSScriptRoot\tokens.ps1"

# Login as mainagent1
$login = @{
  email    = $MAINAGENT1_EMAIL
  password = $MAINAGENT1_PASSWORD
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$token = $auth.access_token

# Create a new invitation to revoke
$create = @{
  workspace_id = $MAINAGENT1_WORKSPACE
} | ConvertTo-Json

$inv = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-create" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" -Body $create

Write-Host "Created invitation: $($inv.invitation_id)" -ForegroundColor Green

# Revoke it
$revoke = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-revoke" `
  -Method POST -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body (@{ invitation_id = $inv.invitation_id } | ConvertTo-Json)

Write-Host "Revoke response:" -ForegroundColor Cyan
$revoke | ConvertTo-Json -Depth 10

# Try to resolve it — should now fail
Write-Host "`nTrying to resolve revoked invitation..." -ForegroundColor Yellow
try {
  Invoke-RestMethod `
    -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/invitations-resolve?token=$($inv.token)" `
    -Method GET
} catch {
  Write-Host "Expected error: $($_.Exception.Response.StatusCode.value__)" -ForegroundColor Red
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host "Body: $($reader.ReadToEnd())"
}