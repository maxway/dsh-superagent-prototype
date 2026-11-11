param(
  [string]$TaskName = 'dsh-superagent-watchdog-observer',
  [ValidateRange(1, 168)][int]$Hours = 24
)

$ErrorActionPreference = 'Stop'
$since = (Get-Date).AddHours(-$Hours)
$result = [ordered]@{ collectedAt = (Get-Date).ToUniversalTime().ToString('o'); since = $since.ToUniversalTime().ToString('o'); task = $TaskName; sources = @() }

function Read-Events([string]$name, [int[]]$ids, [scriptblock]$select) {
  try {
    $channel = Get-WinEvent -ListLog $name -ErrorAction Stop
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = $name; Id = $ids; StartTime = $since } -MaxEvents 500 -ErrorAction Stop | ForEach-Object {
      $event = $_
      $xml = [xml]$event.ToXml()
      $fields = @{}
      foreach ($field in $xml.Event.EventData.Data) { if ($field.Name) { $fields[$field.Name] = $field.'#text' } }
      if (& $select $fields) {
        @{ at = $event.TimeCreated.ToUniversalTime().ToString('o'); id = $event.Id; recordId = $event.RecordId; fields = $fields }
      }
    })
    return @{ channel = $name; enabled = $channel.IsEnabled; events = $events; scanLimit = 500 }
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return @{ channel = $name; enabled = $channel.IsEnabled; events = @(); scanLimit = 500 } }
    return @{ channel = $name; error = $_.Exception.Message; events = @() }
  }
}

$result.sources += Read-Events 'Microsoft-Windows-TaskScheduler/Operational' @(100, 101, 102, 103, 106, 107, 110, 111, 118, 119, 129, 140, 141, 142, 200, 201, 203, 329, 330, 331, 332) {
  param($fields)
  $fields.TaskName -and ($fields.TaskName.TrimStart('\') -ieq $TaskName.TrimStart('\'))
}
$result.sources += Read-Events 'Security' @(4634, 4647, 4689) {
  param($fields)
  if ($fields.ProcessName) { return $fields.ProcessName -match '(?i)\\(node|powershell|pwsh|wscript)\.exe$' }
  return $true
}
$result | ConvertTo-Json -Depth 8
