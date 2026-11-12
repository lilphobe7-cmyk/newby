. "$PSScriptRoot\tokens.ps1"

$login = @{
  email    = "subagent4@example.com"
  password = "Password1!"
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/auth-login" `
  -Method POST -ContentType "application/json" -Body $login

$subToken = $auth.access_token

# SIM held by subagent4 (from our earlier query)
$SIM_ID = "e8e58f42-bc64-4fb0-8cde-43b67074568c"

$body = @{
  sim_id           = $SIM_ID
  outcome          = "REGISTERED"
  phone_number     = "0722000003"
  customer_reference = "TX-ABC-123"
  notes            = "Registered for walk-in customer"
} | ConvertTo-Json

$resp = Invoke-RestMethod `
  -Uri "https://qhqzbibkrvvgnqirgmvo.supabase.co/functions/v1/registrations-report" `
  -Method POST -Headers @{ Authorization = "Bearer $subToken" } `
  -ContentType "application/json" -Body $body

$resp | ConvertTo-Json -Depth 10
$resp.registration.id | Out-File -FilePath "$PSScriptRoot\test-registration-id.txt" -NoNewline -Encoding utf8
Write-Host "`nRegistration ID saved" -ForegroundColor Yellow