param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Extract", "Group", "Resolve", "Export", "All")]
    [string]$Stage,

    [string]$RootFolder,

    [Parameter(Mandatory = $true)]
    [string]$WorkingFolder,

    [string]$OutputCsv,

    [string]$ApiKey,

    [string]$TitlePrefix = "Trip",

    [string]$Notes = "",

    [bool]$Publish = $false,

    [ValidateRange(3, 6)]
    [int]$CoordinatePrecision = 4,

    [ValidateRange(2, 5)]
    [int]$LookupPrecision = 3,

    # 1200 ms = safe for Nominatim's 1-req/sec policy; lower to 250 when using Geoapify
    [int]$ThrottleMs = 1200,

    [switch]$SkipFolderInference,

    [string]$UserAgent = "PhotoGeoExportScript/1.0 (andykeys.me)"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $WorkingFolder)) {
    New-Item -ItemType Directory -Path $WorkingFolder -Force | Out-Null
}

$ExtractCsv = Join-Path $WorkingFolder "01-extracted.csv"
$GroupCsv   = Join-Path $WorkingFolder "02-lookup-groups.csv"
$ResolveCsv = Join-Path $WorkingFolder "03-resolved.csv"
$CacheJson  = Join-Path $WorkingFolder "photo-location-cache.json"

if (-not $OutputCsv) {
    $OutputCsv = Join-Path $WorkingFolder "04-travel-import.csv"
}

Add-Type -AssemblyName System.Drawing

$script:GeoCache = @{}
$script:SearchCache = @{}

function Get-OptionalValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) {
            return $Object[$Name]
        }
        return $null
    }

    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) {
        return $prop.Value
    }

    return $null
}

function Load-GeoCache {
    param([string]$Path)

    $cache = @{}

    if (Test-Path -LiteralPath $Path) {
        try {
            $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $data = $raw | ConvertFrom-Json
                if ($data) {
                    foreach ($item in $data.PSObject.Properties) {
                        $cache[$item.Name] = [pscustomobject]@{
                            Location = Get-OptionalValue -Object $item.Value -Name 'Location'
                            Lat      = [double](Get-OptionalValue -Object $item.Value -Name 'Lat')
                            Lng      = [double](Get-OptionalValue -Object $item.Value -Name 'Lng')
                            Source   = Get-OptionalValue -Object $item.Value -Name 'Source'
                        }
                    }
                }
            }
        }
        catch {
            Write-Warning "Failed to load cache from $Path : $($_.Exception.Message)"
        }
    }

    return $cache
}

function Save-GeoCache {
    param(
        [hashtable]$Cache,
        [string]$Path
    )

    try {
        $ordered = [ordered]@{}
        foreach ($key in ($Cache.Keys | Sort-Object)) {
            $ordered[$key] = $Cache[$key]
        }

        $ordered | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
    }
    catch {
        Write-Warning "Failed to save cache to $Path : $($_.Exception.Message)"
    }
}

function Get-DecFromRationalTriplet {
    param([byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -lt 24) {
        return $null
    }

    $parts = for ($i = 0; $i -lt 3; $i++) {
        $offset = $i * 8
        $num = [BitConverter]::ToUInt32($Bytes, $offset)
        $den = [BitConverter]::ToUInt32($Bytes, $offset + 4)

        if ($den -eq 0) {
            return $null
        }

        [double]$num / [double]$den
    }

    $parts[0] + ($parts[1] / 60.0) + ($parts[2] / 3600.0)
}

function Get-ExifString {
    param(
        [System.Drawing.Image]$Image,
        [int]$Id
    )

    try {
        $prop = $Image.GetPropertyItem($Id)
        ([System.Text.Encoding]::ASCII.GetString($prop.Value)).Trim([char]0, " ")
    }
    catch {
        $null
    }
}

function Get-GpsFromImage {
    param([string]$Path)

    $img = $null
    try {
        $img = [System.Drawing.Image]::FromFile($Path)

        $latBytes = ($img.GetPropertyItem(0x0002)).Value
        $latRef   = Get-ExifString -Image $img -Id 0x0001
        $lonBytes = ($img.GetPropertyItem(0x0004)).Value
        $lonRef   = Get-ExifString -Image $img -Id 0x0003

        $lat = Get-DecFromRationalTriplet -Bytes $latBytes
        $lng = Get-DecFromRationalTriplet -Bytes $lonBytes

        if ($null -eq $lat -or $null -eq $lng) {
            return $null
        }

        if ($latRef -eq "S") { $lat = -$lat }
        if ($lonRef -eq "W") { $lng = -$lng }

        [pscustomobject]@{
            Latitude  = [math]::Round($lat, 6)
            Longitude = [math]::Round($lng, 6)
        }
    }
    catch {
        return $null
    }
    finally {
        if ($img) {
            $img.Dispose()
        }
    }
}

function Get-DateTaken {
    param([string]$Path)

    $img = $null
    try {
        $img = [System.Drawing.Image]::FromFile($Path)

        $raw = Get-ExifString -Image $img -Id 0x9003
        if (-not $raw) {
            $raw = Get-ExifString -Image $img -Id 0x0132
        }

        if ($raw) {
            return [datetime]::ParseExact($raw, "yyyy:MM:dd HH:mm:ss", $null).ToString("yyyy-MM-dd")
        }
    }
    catch {
    }
    finally {
        if ($img) {
            $img.Dispose()
        }
    }

    return (Get-Item -LiteralPath $Path).LastWriteTime.ToString("yyyy-MM-dd")
}

function Get-LocationLabel {
    param(
        [object]$Object,
        [string]$Country
    )

    $fields = @(
        'city',
        'town',
        'village',
        'hamlet',
        'municipality',
        'county',
        'state_district',
        'state'
    )

    foreach ($field in $fields) {
        $value = Get-OptionalValue -Object $Object -Name $field
        if ($value -and $value.ToString().Trim()) {
            $place = $value.ToString().Trim()
            if ($Country) {
                return "$place, $Country"
            }
            return $place
        }
    }

    if ($Country) {
        return $Country
    }

    return $null
}

function Invoke-GeoapifyReverse {
    param(
        [double]$Latitude,
        [double]$Longitude
    )

    $url = "https://api.geoapify.com/v1/geocode/reverse?lat=$Latitude&lon=$Longitude&type=city&format=json&apiKey=$ApiKey"

    $response = Invoke-RestMethod `
        -Uri $url `
        -Method Get `
        -Headers @{
            "User-Agent" = $UserAgent
            "Accept"     = "application/json"
        } `
        -TimeoutSec 30

    $item = $null
    if ($response.results -and $response.results.Count -gt 0) {
        $item = $response.results | Select-Object -First 1
    }

    if (-not $item) {
        return $null
    }

    $country = Get-OptionalValue -Object $item -Name 'country'
    $label = Get-LocationLabel -Object $item -Country $country

    if (-not $label) {
        $formatted = Get-OptionalValue -Object $item -Name 'formatted'
        if ($formatted) {
            $parts = $formatted -split ','
            if ($parts.Count -ge 2) {
                $label = "$($parts[0].Trim()), $($parts[-1].Trim())"
            }
            else {
                $label = $formatted.Trim()
            }
        }
    }

    if (-not $label) {
        return $null
    }

    [pscustomobject]@{
        Location = $label
        Lat      = [math]::Round($Latitude, $CoordinatePrecision)
        Lng      = [math]::Round($Longitude, $CoordinatePrecision)
        Source   = "GPS"
    }
}

function Invoke-NominatimReverse {
    param(
        [double]$Latitude,
        [double]$Longitude
    )

    # zoom=10 returns city/town-level granularity without street-level noise
    $url = "https://nominatim.openstreetmap.org/reverse?lat=$Latitude&lon=$Longitude&format=json&zoom=10"

    $response = Invoke-RestMethod `
        -Uri $url `
        -Method Get `
        -Headers @{
            "User-Agent" = $UserAgent
            "Accept"     = "application/json"
        } `
        -TimeoutSec 30

    if (-not $response) { return $null }

    $addr    = $response.address
    $country = Get-OptionalValue -Object $addr -Name 'country'
    $label   = Get-LocationLabel -Object $addr -Country $country

    if (-not $label) {
        $display = Get-OptionalValue -Object $response -Name 'display_name'
        if ($display) {
            $parts = $display -split ','
            $label = if ($parts.Count -ge 2) {
                "$($parts[0].Trim()), $($parts[-1].Trim())"
            } else {
                $display.Trim()
            }
        }
    }

    if (-not $label) { return $null }

    [pscustomobject]@{
        Location = $label
        Lat      = [math]::Round($Latitude, $CoordinatePrecision)
        Lng      = [math]::Round($Longitude, $CoordinatePrecision)
        Source   = "GPS"
    }
}

function Invoke-NominatimSearch {
    param([string]$Query)

    $encoded  = [System.Uri]::EscapeDataString($Query)
    $url      = "https://nominatim.openstreetmap.org/search?q=$encoded&format=json&limit=1&addressdetails=1"

    $response = Invoke-RestMethod `
        -Uri $url `
        -Method Get `
        -Headers @{
            "User-Agent" = $UserAgent
            "Accept"     = "application/json"
        } `
        -TimeoutSec 30

    $item = if ($response -and $response.Count -gt 0) { $response | Select-Object -First 1 } else { $null }
    if (-not $item) { return $null }

    $addr    = $item.address
    $country = Get-OptionalValue -Object $addr -Name 'country'
    $label   = Get-LocationLabel -Object $addr -Country $country

    if (-not $label) { return $null }

    [pscustomobject]@{
        Location = $label
        Lat      = [math]::Round([double]$item.lat, $CoordinatePrecision)
        Lng      = [math]::Round([double]$item.lon, $CoordinatePrecision)
        Source   = "Folder"
    }
}

function Invoke-ReverseGeocode {
    param(
        [double]$Latitude,
        [double]$Longitude
    )

    $roundedLat = [math]::Round($Latitude, $LookupPrecision)
    $roundedLng = [math]::Round($Longitude, $LookupPrecision)
    $provider   = if ($ApiKey) { 'Geoapify' } else { 'Nominatim' }
    $cacheKey   = "{0},{1}|{2}|city" -f $roundedLat, $roundedLng, $provider

    if ($script:GeoCache.ContainsKey($cacheKey)) {
        return $script:GeoCache[$cacheKey]
    }

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $result = if ($ApiKey) {
                Invoke-GeoapifyReverse -Latitude $roundedLat -Longitude $roundedLng
            } else {
                Invoke-NominatimReverse -Latitude $roundedLat -Longitude $roundedLng
            }
            if ($result) {
                $script:GeoCache[$cacheKey] = $result
                return $result
            }
            return $null
        }
        catch {
            Write-Warning "Reverse geocode attempt $attempt failed for $roundedLat,$roundedLng : $($_.Exception.Message)"
            if ($attempt -lt 3) {
                Start-Sleep -Seconds $attempt
            }
        }
    }

    return $null
}

function Search-PlaceByName {
    param([string]$Query)

    if ($script:SearchCache.ContainsKey($Query)) {
        return $script:SearchCache[$Query]
    }

    try {
        $result = if ($ApiKey) {
            $encoded = [System.Uri]::EscapeDataString($Query)
            $url     = "https://api.geoapify.com/v1/geocode/search?text=$encoded&format=json&limit=1&apiKey=$ApiKey"

            $response = Invoke-RestMethod `
                -Uri $url `
                -Method Get `
                -Headers @{ "User-Agent" = $UserAgent; "Accept" = "application/json" } `
                -TimeoutSec 30

            $item = if ($response.results -and $response.results.Count -gt 0) {
                $response.results | Select-Object -First 1
            } else { $null }

            if (-not $item) { $null } else {
                $country = Get-OptionalValue -Object $item -Name 'country'
                $label   = Get-LocationLabel -Object $item -Country $country
                if (-not $label) { $null } else {
                    [pscustomobject]@{
                        Location = $label
                        Lat      = [math]::Round([double](Get-OptionalValue -Object $item -Name 'lat'), $CoordinatePrecision)
                        Lng      = [math]::Round([double](Get-OptionalValue -Object $item -Name 'lon'), $CoordinatePrecision)
                        Source   = "Folder"
                    }
                }
            }
        } else {
            Invoke-NominatimSearch -Query $Query
        }

        $script:SearchCache[$Query] = $result
        return $result
    }
    catch {
        Write-Warning "Folder inference lookup failed for '$Query' : $($_.Exception.Message)"
        return $null
    }
}

function Get-CandidateFolders {
    param(
        [string]$FilePath,
        [string]$RootFolder
    )

    $parent = Split-Path -LiteralPath $FilePath -Parent
    $relative = $parent.Substring($RootFolder.Length).TrimStart('\', '/')

    if (-not $relative) {
        return @()
    }

    $parts = $relative -split '[\\/]'
    $ignore = @(
        'photos','pictures','camera','phone','mobile','dcim','imports','import',
        'unsorted','misc','random','favorites','favourites','edited','exports',
        'raw','jpg','jpeg','png','heic','tiff','img','images','album','albums',
        'holidays','holiday','trip','travel',
        '2020','2021','2022','2023','2024','2025','2026','2027'
    )

    $candidates = foreach ($part in $parts) {
        $clean = ($part -replace '[_\-]+', ' ' -replace '\s+', ' ').Trim()

        if ($clean.Length -lt 3) { continue }
        if ($clean -match '^\d+$') { continue }
        if ($ignore -contains $clean.ToLowerInvariant()) { continue }

        if ($clean -match '^[A-Za-zÀ-ÿ''\.\-\s,]+$') {
            $clean
        }
    }

    $candidates | Select-Object -Unique | Select-Object -Last 3
}

function Resolve-FromFolderName {
    param(
        [string]$FilePath,
        [string]$RootFolder
    )

    $candidates = Get-CandidateFolders -FilePath $FilePath -RootFolder $RootFolder

    foreach ($candidate in ($candidates | Sort-Object Length -Descending)) {
        $match = Search-PlaceByName -Query $candidate
        if ($match) {
            return $match
        }

        Start-Sleep -Milliseconds $ThrottleMs
    }

    return $null
}

function Invoke-ExtractStage {
    if (-not $RootFolder) {
        throw "RootFolder is required for Extract stage."
    }

    if (-not (Test-Path -LiteralPath $RootFolder)) {
        throw "RootFolder does not exist: $RootFolder"
    }

    $extensions = @("*.jpg", "*.jpeg", "*.tif", "*.tiff", "*.png", "*.heic")
    $files = Get-ChildItem -LiteralPath $RootFolder -Recurse -File -Include $extensions

    if (-not $files) {
        throw "No supported image files found under: $RootFolder"
    }

    $rows = New-Object System.Collections.Generic.List[object]
    $totalFiles = $files.Count
    $fileIndex = 0

    foreach ($file in $files) {
        $fileIndex++
        $percent = [int](($fileIndex / $totalFiles) * 100)

        Write-Progress -Id 0 `
            -Activity "Stage 1/4 - Extracting image metadata" `
            -Status "$fileIndex of $totalFiles" `
            -CurrentOperation $file.FullName `
            -PercentComplete $percent

        $gps = Get-GpsFromImage -Path $file.FullName
        $postDate = Get-DateTaken -Path $file.FullName

        $row = [ordered]@{
            file_path          = $file.FullName
            folder_path        = (Split-Path -LiteralPath $file.FullName -Parent)
            file_name          = $file.Name
            extension          = $file.Extension
            post_date          = $postDate
            latitude           = $null
            longitude          = $null
            gps_found          = $false
            inferred_location  = $null
            inferred_lat       = $null
            inferred_lng       = $null
            source             = $null
        }

        if ($gps) {
            $row.latitude  = $gps.Latitude
            $row.longitude = $gps.Longitude
            $row.gps_found = $true
            $row.source    = "GPS"
        }
        elseif (-not $SkipFolderInference) {
            $folderResult = Resolve-FromFolderName -FilePath $file.FullName -RootFolder $RootFolder
            if ($folderResult) {
                $row.inferred_location = $folderResult.Location
                $row.inferred_lat      = $folderResult.Lat
                $row.inferred_lng      = $folderResult.Lng
                $row.source            = "Folder"
            }
        }

        $rows.Add([pscustomobject]$row)
    }

    Write-Progress -Id 0 -Activity "Stage 1/4 - Extracting image metadata" -Completed

    $rows | Export-Csv -LiteralPath $ExtractCsv -NoTypeInformation -Encoding UTF8
    Write-Host "Extract stage complete: $ExtractCsv"
}

function Invoke-GroupStage {
    if (-not (Test-Path -LiteralPath $ExtractCsv)) {
        throw "Extract CSV not found: $ExtractCsv"
    }

    $rows = Import-Csv -LiteralPath $ExtractCsv
    if (-not $rows) {
        throw "No rows found in extract CSV."
    }

    $grouped = $rows |
        Where-Object {
            ($_.gps_found -eq 'True' -and $_.latitude -and $_.longitude) -or
            ($_.source -eq 'Folder' -and $_.inferred_location)
        } |
        Group-Object {
            if ($_.source -eq 'Folder' -and $_.inferred_location) {
                "FOLDER|$($_.inferred_location)"
            }
            else {
                "GPS|{0}|{1}" -f `
                    ([math]::Round([double]$_.latitude, $LookupPrecision)),
                    ([math]::Round([double]$_.longitude, $LookupPrecision))
            }
        } |
        ForEach-Object {
            $first = $_.Group | Select-Object -First 1
            $gpsRows = $_.Group | Where-Object { $_.gps_found -eq 'True' -and $_.latitude -and $_.longitude }

            $lookupLat = $null
            $lookupLng = $null
            $exportLat = $null
            $exportLng = $null

            if ($gpsRows) {
                # CSV values are strings; explicit cast required before Measure-Object arithmetic
                $avgLat    = ($gpsRows | ForEach-Object { [double]$_.latitude  } | Measure-Object -Average).Average
                $avgLng    = ($gpsRows | ForEach-Object { [double]$_.longitude } | Measure-Object -Average).Average
                $lookupLat = [math]::Round($avgLat, $LookupPrecision)
                $lookupLng = [math]::Round($avgLng, $LookupPrecision)
                $exportLat = [math]::Round($avgLat, $CoordinatePrecision)
                $exportLng = [math]::Round($avgLng, $CoordinatePrecision)
            }
            else {
                $lookupLat = [double]$first.inferred_lat
                $lookupLng = [double]$first.inferred_lng
                $exportLat = [math]::Round([double]$first.inferred_lat, $CoordinatePrecision)
                $exportLng = [math]::Round([double]$first.inferred_lng, $CoordinatePrecision)
            }

            [pscustomobject]@{
                group_key         = $_.Name
                item_count        = $_.Count
                source            = $first.source
                lookup_latitude   = $lookupLat
                lookup_longitude  = $lookupLng
                export_lat        = $exportLat
                export_lng        = $exportLng
                inferred_location = $first.inferred_location
                resolved_location = $null
                post_date         = ($_.Group | Sort-Object post_date | Select-Object -First 1).post_date
                status            = if ($first.source -eq 'Folder') { 'resolved' } else { 'pending' }
            }
        }

    $grouped | Export-Csv -LiteralPath $GroupCsv -NoTypeInformation -Encoding UTF8
    Write-Host "Group stage complete: $GroupCsv"
}

function Invoke-ResolveStage {
    $provider = if ($ApiKey) { "Geoapify (ApiKey provided)" } else { "Nominatim (free, 1 req/sec — set -ApiKey to use Geoapify)" }
    Write-Host "Geocoding provider: $provider"

    if (-not (Test-Path -LiteralPath $GroupCsv)) {
        throw "Group CSV not found: $GroupCsv"
    }

    $script:GeoCache = Load-GeoCache -Path $CacheJson
    $rows = Import-Csv -LiteralPath $GroupCsv
    $updated = New-Object System.Collections.Generic.List[object]

    $totalRows = $rows.Count
    $rowIndex = 0

    foreach ($row in $rows) {
        $rowIndex++
        $percent = [int](($rowIndex / $totalRows) * 100)

        Write-Progress -Id 1 `
            -Activity "Stage 3/4 - Resolving locations" `
            -Status "$rowIndex of $totalRows" `
            -CurrentOperation $row.group_key `
            -PercentComplete $percent

        $resolvedLocation = $row.resolved_location
        $status = $row.status

        if ($row.source -eq 'Folder' -and $row.inferred_location) {
            $resolvedLocation = $row.inferred_location
            $status = 'resolved'
        }
        elseif ($row.status -ne 'resolved' -and $row.lookup_latitude -and $row.lookup_longitude) {
            $geo = Invoke-ReverseGeocode -Latitude ([double]$row.lookup_latitude) -Longitude ([double]$row.lookup_longitude)
            if ($geo) {
                $resolvedLocation = $geo.Location
                $status = 'resolved'
                Save-GeoCache -Cache $script:GeoCache -Path $CacheJson
            }
            else {
                $status = 'failed'
            }

            Start-Sleep -Milliseconds $ThrottleMs
        }

        $updated.Add([pscustomobject]@{
            group_key         = $row.group_key
            item_count        = $row.item_count
            source            = $row.source
            lookup_latitude   = $row.lookup_latitude
            lookup_longitude  = $row.lookup_longitude
            export_lat        = $row.export_lat
            export_lng        = $row.export_lng
            inferred_location = $row.inferred_location
            resolved_location = $resolvedLocation
            post_date         = $row.post_date
            status            = $status
        })
    }

    Write-Progress -Id 1 -Activity "Stage 3/4 - Resolving locations" -Completed

    $updated | Export-Csv -LiteralPath $ResolveCsv -NoTypeInformation -Encoding UTF8
    Save-GeoCache -Cache $script:GeoCache -Path $CacheJson
    Write-Host "Resolve stage complete: $ResolveCsv"
}

function Invoke-ExportStage {
    if (-not (Test-Path -LiteralPath $ResolveCsv)) {
        throw "Resolved CSV not found: $ResolveCsv"
    }

    $rows = Import-Csv -LiteralPath $ResolveCsv |
        Where-Object { $_.status -eq 'resolved' -and $_.resolved_location }

    if (-not $rows) {
        throw "No resolved rows found in resolved CSV."
    }

    $final = $rows |
        Group-Object resolved_location |
        ForEach-Object {
            $_.Group | Sort-Object post_date | Select-Object -First 1
        } |
        Sort-Object resolved_location |
        ForEach-Object {
            [pscustomobject]@{
                title     = $TitlePrefix
                location  = $_.resolved_location
                notes     = $Notes
                post_date = $_.post_date
                lat       = [math]::Round([double]$_.export_lat, $CoordinatePrecision)
                lng       = [math]::Round([double]$_.export_lng, $CoordinatePrecision)
                publish   = $Publish.ToString().ToLowerInvariant()
            }
        }

    $final |
        Select-Object title, location, notes, post_date, lat, lng, publish |
        Export-Csv -LiteralPath $OutputCsv -NoTypeInformation -Encoding UTF8

    Write-Host "Export stage complete: $OutputCsv"
}

switch ($Stage) {
    "Extract" { Invoke-ExtractStage }
    "Group"   { Invoke-GroupStage }
    "Resolve" { Invoke-ResolveStage }
    "Export"  { Invoke-ExportStage }
    "All" {
        Invoke-ExtractStage
        Invoke-GroupStage
        Invoke-ResolveStage
        Invoke-ExportStage
    }
}