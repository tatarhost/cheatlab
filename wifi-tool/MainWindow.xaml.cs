using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace CheatLab.WifiStudio;

public partial class MainWindow : Window
{
    private const string SpeedBase = "https://speed.cloudflare.com";
    private static readonly HttpClient SpeedClient = new()
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    private readonly ObservableCollection<WirelessNetwork> _networks = new();
    private readonly List<WifiAdapter> _adapters = new();
    private readonly List<AdapterSetting> _settings = new();
    private readonly List<AppliedChange> _backups = new();
    private readonly string _backupPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CHEATLAB", "WiFiStudio", "settings-backup.json");

    private CancellationTokenSource? _speedCancellation;
    private AdapterSetting? _previewSetting;
    private string? _previewValue;
    private bool _loadingSettings;

    public MainWindow()
    {
        InitializeComponent();
        NetworksGrid.ItemsSource = _networks;
        Loaded += Window_Loaded;
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        LoadBackups();
        RefreshBackupList();
        await ScanNetworksAsync();
        await LoadAdapterSettingsAsync();
    }

    // ------------------------------- Internet speed test

    private async void SpeedButton_Click(object sender, RoutedEventArgs e)
    {
        if (_speedCancellation is not null)
        {
            _speedCancellation.Cancel();
            SpeedStatus.Text = "Останавливаем тест…";
            return;
        }

        _speedCancellation = new CancellationTokenSource(TimeSpan.FromSeconds(65));
        var token = _speedCancellation.Token;
        SpeedButton.Content = "Остановить тест";
        DownloadValue.Text = "…";
        UploadValue.Text = "…";
        LatencyValue.Text = "…";

        try
        {
            SpeedStatus.Text = "Измеряем задержку…";
            var latency = await MeasureLatencyAsync(token);
            LatencyValue.Text = latency.ToString("0", CultureInfo.InvariantCulture);

            SpeedStatus.Text = "Проверяем скорость загрузки…";
            var download = await MeasureDownloadAsync(token);
            DownloadValue.Text = download.ToString("0.0", CultureInfo.InvariantCulture);

            SpeedStatus.Text = "Проверяем скорость отправки…";
            var upload = await MeasureUploadAsync(token);
            UploadValue.Text = upload.ToString("0.0", CultureInfo.InvariantCulture);

            SpeedStatus.Text = "Тест завершён · Cloudflare";
        }
        catch (OperationCanceledException)
        {
            SpeedStatus.Text = "Тест остановлен.";
        }
        catch (Exception ex)
        {
            SpeedStatus.Text = "Ошибка измерения: " + ShortError(ex.Message);
        }
        finally
        {
            _speedCancellation.Dispose();
            _speedCancellation = null;
            SpeedButton.Content = "Запустить тест";
        }
    }

    private static async Task<double> MeasureLatencyAsync(CancellationToken token)
    {
        var samples = new List<double>();
        for (var i = 0; i < 3; i++)
        {
            var url = $"{SpeedBase}/__down?bytes=16384&nonce={Guid.NewGuid():N}";
            var watch = Stopwatch.StartNew();
            using var response = await SpeedClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(token);
            var buffer = new byte[4096];
            while (await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), token) > 0) { }
            watch.Stop();
            samples.Add(watch.Elapsed.TotalMilliseconds);
        }

        samples.Sort();
        return samples[samples.Count / 2];
    }

    private static async Task<double> MeasureDownloadAsync(CancellationToken token)
    {
        const int bytesRequested = 8_000_000;
        var url = $"{SpeedBase}/__down?bytes={bytesRequested}&nonce={Guid.NewGuid():N}";
        var watch = Stopwatch.StartNew();
        using var response = await SpeedClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();

        long received = 0;
        await using (var stream = await response.Content.ReadAsStreamAsync(token))
        {
            var buffer = new byte[64 * 1024];
            int read;
            while ((read = await stream.ReadAsync(buffer.AsMemory(), token)) > 0)
                received += read;
        }

        watch.Stop();
        if (received <= 0 || watch.Elapsed.TotalSeconds <= 0)
            throw new InvalidOperationException("Сервер измерения не вернул данные для загрузки.");
        return received * 8d / watch.Elapsed.TotalSeconds / 1_000_000d;
    }

    private static async Task<double> MeasureUploadAsync(CancellationToken token)
    {
        const int payloadSize = 1_500_000;
        var payload = new byte[payloadSize];
        for (var offset = 0; offset < payload.Length; offset += 65_536)
        {
            var count = Math.Min(65_536, payload.Length - offset);
            RandomNumberGenerator.Fill(payload.AsSpan(offset, count));
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{SpeedBase}/__up?nonce={Guid.NewGuid():N}");
        request.Content = new ByteArrayContent(payload);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

        var watch = Stopwatch.StartNew();
        using var response = await SpeedClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode();
        await response.Content.LoadIntoBufferAsync();
        watch.Stop();

        if (watch.Elapsed.TotalSeconds <= 0)
            throw new InvalidOperationException("Не удалось измерить отправку данных.");
        return payload.Length * 8d / watch.Elapsed.TotalSeconds / 1_000_000d;
    }

    // -------------------------------- Wi-Fi channel scan

    private async void ScanButton_Click(object sender, RoutedEventArgs e)
    {
        await ScanNetworksAsync();
    }

    private async Task ScanNetworksAsync()
    {
        ScanButton.IsEnabled = false;
        ScanButton.Content = "Сканирование…";
        CurrentWifiText.Text = "Windows ищет видимые Wi-Fi сети…";

        try
        {
            var connectedTask = RunCommandAsync("netsh.exe", "wlan show interfaces");
            var networksTask = RunCommandAsync("netsh.exe", "wlan show networks mode=bssid");
            await Task.WhenAll(connectedTask, networksTask);

            var connected = ParseInterface(connectedTask.Result.Output);
            var found = ParseNetworks(networksTask.Result.Output);

            _networks.Clear();
            foreach (var item in found.OrderBy(x => x.Channel).ThenBy(x => x.Ssid, StringComparer.OrdinalIgnoreCase))
                _networks.Add(item);

            CurrentWifiText.Text = connected.Length > 0
                ? connected + $" · найдено точек доступа: {found.Count}"
                : $"Найдено точек доступа: {found.Count}. Текущая сеть не определена.";

            DrawChannelBars(found);
            RecommendedText.Text = BuildRecommendation(found);

            if (found.Count == 0)
                CurrentWifiText.Text += " Проверь, что Wi-Fi включён и служба автонастройки WLAN работает.";
        }
        catch (Exception ex)
        {
            CurrentWifiText.Text = "Не удалось выполнить сканирование: " + ShortError(ex.Message);
            RecommendedText.Text = "Проверь Wi-Fi адаптер и службу WLAN AutoConfig.";
            ChannelBarsPanel.Children.Clear();
            _networks.Clear();
        }
        finally
        {
            ScanButton.IsEnabled = true;
            ScanButton.Content = "Сканировать снова";
        }
    }

    private static string ParseInterface(string output)
    {
        string? ssid = null;
        string? state = null;
        string? channel = null;
        string? signal = null;

        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();
            var match = Regex.Match(trimmed, @"^SSID\s*:\s*(.*)$", RegexOptions.IgnoreCase);
            if (match.Success) ssid = match.Groups[1].Value.Trim();

            match = Regex.Match(trimmed, @"^(?:State|Состояние)\s*:\s*(.*)$", RegexOptions.IgnoreCase);
            if (match.Success) state = match.Groups[1].Value.Trim();

            match = Regex.Match(trimmed, @"^(?:Channel|Канал)\s*:\s*(\d+)", RegexOptions.IgnoreCase);
            if (match.Success) channel = match.Groups[1].Value;

            match = Regex.Match(trimmed, @"^(?:Signal|Сигнал)\s*:\s*(\d+)\s*%", RegexOptions.IgnoreCase);
            if (match.Success) signal = match.Groups[1].Value + "%";
        }

        if (string.IsNullOrWhiteSpace(ssid) && string.IsNullOrWhiteSpace(state))
            return "";

        return $"Сеть: {(string.IsNullOrWhiteSpace(ssid) ? "—" : ssid)} · Статус: {state ?? "—"} · Канал: {channel ?? "—"} · Сигнал: {signal ?? "—"}";
    }

    private static List<WirelessNetwork> ParseNetworks(string output)
    {
        var result = new List<WirelessNetwork>();
        string currentSsid = "";
        WirelessNetwork? current = null;

        void Commit()
        {
            if (current is not null && current.Channel > 0)
                result.Add(current);
            current = null;
        }

        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();

            var ssidMatch = Regex.Match(trimmed, @"^SSID\s+\d+\s*:\s*(.*)$", RegexOptions.IgnoreCase);
            if (ssidMatch.Success)
            {
                Commit();
                currentSsid = ssidMatch.Groups[1].Value.Trim();
                continue;
            }

            var bssidMatch = Regex.Match(trimmed, @"^BSSID\s+\d+\s*:\s*([0-9a-f:]{17})", RegexOptions.IgnoreCase);
            if (bssidMatch.Success)
            {
                Commit();
                current = new WirelessNetwork
                {
                    Ssid = string.IsNullOrWhiteSpace(currentSsid) ? "(скрытая сеть)" : currentSsid,
                    Bssid = bssidMatch.Groups[1].Value.ToUpperInvariant(),
                };
                continue;
            }

            if (current is null) continue;

            var channelMatch = Regex.Match(trimmed, @"^(?:Channel|Канал)\s*:\s*(\d+)", RegexOptions.IgnoreCase);
            if (channelMatch.Success && int.TryParse(channelMatch.Groups[1].Value, out var channel))
                current.Channel = channel;

            var signalMatch = Regex.Match(trimmed, @"^(?:Signal|Сигнал)\s*:\s*(\d+)\s*%", RegexOptions.IgnoreCase);
            if (signalMatch.Success && int.TryParse(signalMatch.Groups[1].Value, out var signal))
                current.Signal = Math.Clamp(signal, 0, 100);
        }

        Commit();
        return result
            .GroupBy(x => x.Bssid, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .ToList();
    }

    private void DrawChannelBars(List<WirelessNetwork> found)
    {
        ChannelBarsPanel.Children.Clear();
        AddTextLine(ChannelBarsPanel, "2,4 ГГц · КАНАЛЫ 1 / 6 / 11", 9, true, "#A2A2A8");

        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 9, 0, 14) };
        foreach (var channel in new[] { 1, 6, 11 })
        {
            var count = found.Count(n => n.Channel <= 14 && Math.Abs(n.Channel - channel) <= 2);
            var column = new StackPanel { Width = 150, Margin = new Thickness(0, 0, 16, 0) };
            column.Children.Add(new TextBlock
            {
                Text = $"Канал {channel} · {count} рядом",
                Foreground = Brushes.Gainsboro,
                FontSize = 11,
                Margin = new Thickness(0, 0, 0, 6),
            });
            var track = new Border
            {
                Height = 7,
                Background = new SolidColorBrush(Color.FromRgb(54, 54, 59)),
                CornerRadius = new CornerRadius(2),
                Child = new Border
                {
                    Width = Math.Clamp(count * 22, count == 0 ? 0 : 14, 136),
                    HorizontalAlignment = HorizontalAlignment.Left,
                    Background = new SolidColorBrush(Color.FromRgb(221, 221, 221)),
                    CornerRadius = new CornerRadius(2),
                }
            };
            column.Children.Add(track);
            row.Children.Add(column);
        }
        ChannelBarsPanel.Children.Add(row);

        var five = found.Where(n => n.Channel > 14).GroupBy(n => n.Channel).OrderBy(g => g.Key)
            .Select(g => $"{g.Key} ({g.Count()})").ToList();
        AddTextLine(ChannelBarsPanel,
            five.Count == 0 ? "5/6 ГГц · видимые каналы не обнаружены" : "5/6 ГГц · " + string.Join("   ", five),
            10, false, "#A2A2A8");
    }

    private static void AddTextLine(Panel panel, string text, double fontSize, bool bold, string color)
    {
        panel.Children.Add(new TextBlock
        {
            Text = text,
            FontSize = fontSize,
            FontWeight = bold ? FontWeights.Bold : FontWeights.Normal,
            Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(color)),
        });
    }

    private static string BuildRecommendation(List<WirelessNetwork> found)
    {
        var channels = new[] { 1, 6, 11 };
        if (!found.Any(n => n.Channel is >= 1 and <= 14))
            return "Сети 2,4 ГГц не обнаружены. Нужен отдельный просмотр параметров роутера.";

        var ranking = channels.Select(candidate =>
        {
            var score = found
                .Where(n => n.Channel is >= 1 and <= 14)
                .Sum(n => Math.Max(0, 5 - Math.Abs(n.Channel - candidate)));
            return new { Channel = candidate, Score = score };
        }).OrderBy(x => x.Score).ThenBy(x => x.Channel == 6 ? 0 : 1).ToList();

        return $"По видимым сетям наименее загружен канал {ranking[0].Channel}. Следующий вариант: {ranking[1].Channel}. Это рекомендация для ручной проверки в настройках роутера.";
    }

    // -------------------------------- Adapter settings discovery

    private async Task LoadAdapterSettingsAsync()
    {
        _loadingSettings = true;
        SettingsStatus.Text = "Ищем Wi-Fi адаптеры и безопасные параметры драйвера…";
        AdapterPicker.ItemsSource = null;
        PropertyPicker.ItemsSource = null;
        TargetValuePicker.ItemsSource = null;
        _adapters.Clear();
        _settings.Clear();

        const string script = """
$ErrorActionPreference = 'Stop'
$wifi = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {
    $_.NdisPhysicalMedium -eq 9 -or
    $_.Name -match '(?i)wi.?fi|wlan|wireless' -or
    $_.InterfaceDescription -match '(?i)wi.?fi|wlan|wireless|802\.11'
})
if ($wifi.Count -eq 0) {
    $wifi = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '(?i)wi.?fi|wlan|wireless' -or
        $_.InterfaceDescription -match '(?i)wi.?fi|wlan|wireless|802\.11'
    })
}
$allowedKeys = @('*RoamAggressiveness','*RoamingAggressiveness','*PreferredBand','*TransmitPower','*TxPower')
$displayPattern = '(?i)(preferred\s*band|roaming\s*aggressiveness|transmit\s*power|предпочитаемая\s*полоса|агрессивность\s*роуминга|мощность\s*передачи)'
$settings = @()
foreach ($adapter in $wifi) {
    $props = @(Get-NetAdapterAdvancedProperty -Name $adapter.Name -AllProperties -ErrorAction SilentlyContinue)
    foreach ($property in $props) {
        $keyword = [string]$property.RegistryKeyword
        $display = [string]$property.DisplayName
        $known = ($allowedKeys -contains $keyword) -or ($display -match $displayPattern)
        $valid = @($property.ValidDisplayValues | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($known -and $valid.Count -gt 1 -and -not [string]::IsNullOrWhiteSpace($keyword) -and -not [string]::IsNullOrWhiteSpace($display)) {
            $settings += [pscustomobject]@{
                Adapter = [string]$adapter.Name
                DisplayName = $display
                RegistryKeyword = $keyword
                CurrentValue = [string]$property.DisplayValue
                ValidValues = @($valid)
            }
        }
    }
}
$result = [pscustomobject]@{
    Adapters = @($wifi | ForEach-Object {
        [pscustomobject]@{ Name = [string]$_.Name; Description = [string]$_.InterfaceDescription; Status = [string]$_.Status }
    })
    Properties = @($settings)
}
$json = ConvertTo-Json -InputObject $result -Depth 8 -Compress
[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
""";

        try
        {
            var encoded = await RunPowerShellAsync(script, CancellationToken.None);
            var jsonBytes = Convert.FromBase64String(encoded.Trim());
            using var document = JsonDocument.Parse(jsonBytes);
            var root = document.RootElement;

            if (root.TryGetProperty("Adapters", out var adaptersElement) && adaptersElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in adaptersElement.EnumerateArray())
                {
                    _adapters.Add(new WifiAdapter
                    {
                        Name = ReadJsonString(item, "Name"),
                        Description = ReadJsonString(item, "Description"),
                        Status = ReadJsonString(item, "Status"),
                    });
                }
            }

            if (root.TryGetProperty("Properties", out var propertiesElement) && propertiesElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in propertiesElement.EnumerateArray())
                {
                    var setting = new AdapterSetting
                    {
                        Adapter = ReadJsonString(item, "Adapter"),
                        DisplayName = ReadJsonString(item, "DisplayName"),
                        RegistryKeyword = ReadJsonString(item, "RegistryKeyword"),
                        CurrentValue = ReadJsonString(item, "CurrentValue"),
                    };
                    if (item.TryGetProperty("ValidValues", out var valid) && valid.ValueKind == JsonValueKind.Array)
                        setting.ValidValues = valid.EnumerateArray().Select(v => v.GetString() ?? "").Where(v => v.Length > 0).ToList();

                    if (IsAllowedSetting(setting) && setting.ValidValues.Count > 1)
                        _settings.Add(setting);
                }
            }

            AdapterPicker.ItemsSource = _adapters;
            if (_adapters.Count > 0)
                AdapterPicker.SelectedIndex = 0;

            SettingsStatus.Text = _adapters.Count == 0
                ? "Wi-Fi адаптер не найден. Подключи Wi-Fi и обнови вкладку."
                : $"Найдено адаптеров: {_adapters.Count} · доступных обратимых параметров: {_settings.Count}.";
        }
        catch (Exception ex)
        {
            SettingsStatus.Text = "Не удалось прочитать параметры драйвера: " + ShortError(ex.Message);
        }
        finally
        {
            _loadingSettings = false;
            PopulateSettingsForSelectedAdapter();
            UpdateApplyState();
        }
    }

    private static bool IsAllowedSetting(AdapterSetting setting)
    {
        if (string.IsNullOrWhiteSpace(setting.RegistryKeyword) || string.IsNullOrWhiteSpace(setting.DisplayName))
            return false;

        return Regex.IsMatch(setting.DisplayName,
            @"(?i)(preferred\s*band|roaming\s*aggressiveness|transmit\s*power|предпочитаемая\s*полоса|агрессивность\s*роуминга|мощность\s*передачи)");
    }

    private void AdapterPicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_loadingSettings) return;
        PopulateSettingsForSelectedAdapter();
    }

    private void PopulateSettingsForSelectedAdapter()
    {
        if (AdapterPicker.SelectedItem is not WifiAdapter adapter)
        {
            PropertyPicker.ItemsSource = null;
            TargetValuePicker.ItemsSource = null;
            return;
        }

        var items = _settings
            .Where(s => string.Equals(s.Adapter, adapter.Name, StringComparison.OrdinalIgnoreCase))
            .OrderBy(s => s.DisplayName)
            .ToList();
        PropertyPicker.ItemsSource = items;
        if (items.Count > 0)
            PropertyPicker.SelectedIndex = 0;
        else
        {
            TargetValuePicker.ItemsSource = null;
            PreviewText.Text = "Драйвер этого адаптера не предоставил поддерживаемых обратимых параметров.";
        }
    }

    private void PropertyPicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        _previewSetting = null;
        _previewValue = null;
        if (PropertyPicker.SelectedItem is not AdapterSetting setting)
        {
            TargetValuePicker.ItemsSource = null;
            UpdateApplyState();
            return;
        }

        TargetValuePicker.ItemsSource = setting.ValidValues;
        TargetValuePicker.SelectedItem = setting.ValidValues.Contains(setting.CurrentValue)
            ? setting.CurrentValue
            : setting.ValidValues.FirstOrDefault();

        PreviewText.Text = $"Текущее значение «{setting.DisplayName}»: {setting.CurrentValue}. Выбери новое значение и нажми «Показать изменения».";
        UpdateApplyState();
    }

    private void TargetValuePicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        _previewSetting = null;
        _previewValue = null;
        UpdateApplyState();
    }

    private void PreviewButton_Click(object sender, RoutedEventArgs e)
    {
        if (PropertyPicker.SelectedItem is not AdapterSetting setting ||
            TargetValuePicker.SelectedItem is not string target)
        {
            MessageBox.Show("Сначала выбери параметр и новое значение.", "Wi-Fi Studio",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (!IsAllowedSetting(setting) || !setting.ValidValues.Contains(target))
        {
            MessageBox.Show("Это значение не разрешено для изменения.", "Wi-Fi Studio",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (string.Equals(setting.CurrentValue, target, StringComparison.OrdinalIgnoreCase))
        {
            PreviewText.Text = "Изменение не требуется: выбрано текущее значение.";
            _previewSetting = null;
            _previewValue = null;
            UpdateApplyState();
            return;
        }

        _previewSetting = setting;
        _previewValue = target;
        PreviewText.Text = $"АДАПТЕР: {setting.Adapter}\nПАРАМЕТР: {setting.DisplayName}\nБЫЛО: {setting.CurrentValue}\nСТАНЕТ: {target}\n\nИзменение ещё не применено. Нажми «Применить», чтобы подтвердить его и открыть запрос Windows UAC.";
        UpdateApplyState();
    }

    private async void ApplyButton_Click(object sender, RoutedEventArgs e)
    {
        if (_previewSetting is null || _previewValue is null)
            return;

        var setting = _previewSetting;
        var value = _previewValue;
        var answer = MessageBox.Show(
            $"Применить изменение?\n\nАдаптер: {setting.Adapter}\nПараметр: {setting.DisplayName}\n{setting.CurrentValue}  →  {value}\n\nИсходное значение будет сохранено для отката. Windows может запросить права администратора.",
            "Подтверждение изменения Wi-Fi",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);

        if (answer != MessageBoxResult.Yes) return;

        var record = new AppliedChange
        {
            Adapter = setting.Adapter,
            DisplayName = setting.DisplayName,
            RegistryKeyword = setting.RegistryKeyword,
            Before = setting.CurrentValue,
            After = value,
            AppliedAtUtc = DateTime.UtcNow,
            Reverted = false,
        };

        _backups.Add(record);
        await SaveBackupsAsync();
        RefreshBackupList();
        ApplyButton.IsEnabled = false;
        SettingsStatus.Text = "Сохраняем резервную копию и применяем значение…";

        try
        {
            var payload = new { Adapter = record.Adapter, RegistryKeyword = record.RegistryKeyword, Value = record.After };
            var exitCode = await RunElevatedPowerShellAsync(BuildApplyScript(payload));
            if (exitCode != 0)
                throw new InvalidOperationException($"PowerShell завершился с кодом {exitCode}.");

            PreviewText.Text += "\n\nИзменение применено. Резервная копия сохранена.";
            SettingsStatus.Text = "Изменение применено. Для некоторых драйверов требуется переподключить Wi-Fi.";
            await LoadAdapterSettingsAsync();
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            _backups.Remove(record);
            await SaveBackupsAsync();
            RefreshBackupList();
            SettingsStatus.Text = "Запрос прав администратора отменён. Настройки не изменены.";
        }
        catch (Exception ex)
        {
            SettingsStatus.Text = "Не удалось подтвердить применение. Сохранённая копия оставлена на случай отката: " + ShortError(ex.Message);
        }
        finally
        {
            UpdateApplyState();
        }
    }

    private async void RevertButton_Click(object sender, RoutedEventArgs e)
    {
        var pending = _backups.Where(b => !b.Reverted)
            .OrderByDescending(b => b.AppliedAtUtc)
            .ToList();

        if (pending.Count == 0)
        {
            MessageBox.Show("Нет сохранённых изменений для отката.", "Wi-Fi Studio",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var answer = MessageBox.Show(
            $"Вернуть исходные значения для {pending.Count} сохранённых изменений?\n\nОткат выполняется в обратном порядке. Windows запросит права администратора.",
            "Откат параметров Wi-Fi",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);

        if (answer != MessageBoxResult.Yes) return;

        RevertButton.IsEnabled = false;
        SettingsStatus.Text = "Возвращаем сохранённые значения…";
        try
        {
            var payload = pending.Select(p => new
            {
                Adapter = p.Adapter,
                RegistryKeyword = p.RegistryKeyword,
                DisplayName = p.DisplayName,
                Value = p.Before,
            }).ToList();

            var exitCode = await RunElevatedPowerShellAsync(BuildRevertScript(payload));
            if (exitCode != 0)
                throw new InvalidOperationException($"PowerShell завершился с кодом {exitCode}.");

            foreach (var record in pending)
                record.Reverted = true;

            await SaveBackupsAsync();
            RefreshBackupList();
            SettingsStatus.Text = "Исходные значения восстановлены.";
            PreviewText.Text = "Откат завершён. Для некоторых драйверов может понадобиться переподключить Wi-Fi.";
            await LoadAdapterSettingsAsync();
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            SettingsStatus.Text = "Запрос прав администратора отменён. Откат не выполнен.";
        }
        catch (Exception ex)
        {
            SettingsStatus.Text = "Не удалось завершить откат: " + ShortError(ex.Message);
        }
        finally
        {
            RefreshBackupList();
        }
    }

    private static string BuildApplyScript(object payload)
    {
        var json64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload)));
        return $$"""
$ErrorActionPreference = 'Stop'
try {
    $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{{json64}}'))
    $payload = ConvertFrom-Json -InputObject $payloadJson
    $pattern = '(?i)(preferred\s*band|roaming\s*aggressiveness|transmit\s*power|предпочитаемая\s*полоса|агрессивность\s*роуминга|мощность\s*передачи)'
    $property = @(Get-NetAdapterAdvancedProperty -Name $payload.Adapter -AllProperties -ErrorAction Stop | Where-Object { [string]$_.RegistryKeyword -ceq [string]$payload.RegistryKeyword } | Select-Object -First 1)
    if ($property.Count -eq 0) { throw 'Параметр адаптера больше не найден.' }
    $property = $property[0]
    if ($property.DisplayName -notmatch $pattern) { throw 'Параметр не входит в разрешённый список.' }
    $valid = @($property.ValidDisplayValues | ForEach-Object { [string]$_ })
    if ($valid -notcontains [string]$payload.Value) { throw 'Значение не поддерживается драйвером.' }
    Set-NetAdapterAdvancedProperty -Name $payload.Adapter -RegistryKeyword $payload.RegistryKeyword -DisplayValue ([string]$payload.Value) -NoRestart -ErrorAction Stop
    exit 0
} catch {
    Write-Error $_
    exit 1
}
""";
    }

    private static string BuildRevertScript(object payload)
    {
        var json64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload)));
        return $$"""
$ErrorActionPreference = 'Stop'
try {
    $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{{json64}}'))
    $items = @(ConvertFrom-Json -InputObject $payloadJson)
    $pattern = '(?i)(preferred\s*band|roaming\s*aggressiveness|transmit\s*power|предпочитаемая\s*полоса|агрессивность\s*роуминга|мощность\s*передачи)'
    foreach ($item in $items) {
        $property = @(Get-NetAdapterAdvancedProperty -Name $item.Adapter -AllProperties -ErrorAction Stop | Where-Object { [string]$_.RegistryKeyword -ceq [string]$item.RegistryKeyword } | Select-Object -First 1)
        if ($property.Count -eq 0) { throw ('Параметр адаптера больше не найден: ' + $item.DisplayName) }
        $property = $property[0]
        if ($property.DisplayName -notmatch $pattern) { throw ('Недопустимый параметр: ' + $item.DisplayName) }
        $valid = @($property.ValidDisplayValues | ForEach-Object { [string]$_ })
        if ($valid -notcontains [string]$item.Value) { throw ('Исходное значение больше не поддерживается: ' + $item.DisplayName) }
        Set-NetAdapterAdvancedProperty -Name $item.Adapter -RegistryKeyword $item.RegistryKeyword -DisplayValue ([string]$item.Value) -NoRestart -ErrorAction Stop
    }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
""";
    }

    private async Task<int> RunElevatedPowerShellAsync(string script)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {encoded}",
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить PowerShell с правами администратора.");
        await process.WaitForExitAsync();
        return process.ExitCode;
    }

    private void LoadBackups()
    {
        try
        {
            if (!File.Exists(_backupPath)) return;
            var json = File.ReadAllText(_backupPath, Encoding.UTF8);
            var stored = JsonSerializer.Deserialize<List<AppliedChange>>(json);
            if (stored is not null)
                _backups.AddRange(stored);
        }
        catch
        {
            _backups.Clear();
        }
    }

    private async Task SaveBackupsAsync()
    {
        var folder = Path.GetDirectoryName(_backupPath)!;
        Directory.CreateDirectory(folder);
        var json = JsonSerializer.Serialize(_backups, new JsonSerializerOptions { WriteIndented = true });
        var tempPath = _backupPath + ".tmp";
        await File.WriteAllTextAsync(tempPath, json, Encoding.UTF8);
        File.Move(tempPath, _backupPath, true);
    }

    private void RefreshBackupList()
    {
        var active = _backups.Where(b => !b.Reverted)
            .OrderByDescending(b => b.AppliedAtUtc)
            .Select(b => $"{b.AppliedAtUtc.ToLocalTime():dd.MM.yyyy HH:mm} · {b.Adapter} · {b.DisplayName}: {b.Before} → {b.After}")
            .ToList();

        BackupList.ItemsSource = active;
        RevertButton.IsEnabled = active.Count > 0;
    }

    private void UpdateApplyState()
    {
        ApplyButton.IsEnabled = _previewSetting is not null &&
                                _previewValue is not null &&
                                TargetValuePicker.SelectedItem is string value &&
                                string.Equals(value, _previewValue, StringComparison.Ordinal);
    }

    // -------------------------------- Router admin shortcut

    private async void OpenRouter_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var gateway = await RunPowerShellAsync(
                "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4DefaultGateway.NextHop } | Select-Object -First 1",
                CancellationToken.None);

            var ip = gateway.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim())
                .FirstOrDefault(x => IPAddress.TryParse(x, out var address) && address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork);

            if (ip is null)
            {
                MessageBox.Show("Шлюз не найден. Проверь, что компьютер подключён к сети.", "Wi-Fi Studio",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            Process.Start(new ProcessStartInfo("http://" + ip) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show("Не удалось открыть панель роутера: " + ShortError(ex.Message), "Wi-Fi Studio",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    // -------------------------------- Process and JSON helpers

    private static async Task<(int ExitCode, string Output, string Error)> RunCommandAsync(string file, string arguments)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        Encoding encoding;
        try { encoding = Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
        catch { encoding = Encoding.UTF8; }

        var startInfo = new ProcessStartInfo
        {
            FileName = file,
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = encoding,
            StandardErrorEncoding = encoding,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить " + file);
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? output : error);
        return (process.ExitCode, output, error);
    }

    private static async Task<string> RunPowerShellAsync(string script, CancellationToken token)
    {
        var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Не удалось запустить PowerShell.");
        var outputTask = process.StandardOutput.ReadToEndAsync(token);
        var errorTask = process.StandardError.ReadToEndAsync(token);
        await process.WaitForExitAsync(token);
        var output = await outputTask;
        var error = await errorTask;
        if (process.ExitCode != 0)
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(error) ? output : error);
        return output.Trim();
    }

    private static string ReadJsonString(JsonElement element, string property)
    {
        return element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";
    }

    private static string ShortError(string message)
    {
        var cleaned = Regex.Replace(message ?? "", @"\s+", " ").Trim();
        return cleaned.Length > 220 ? cleaned[..220] + "…" : cleaned;
    }
}
