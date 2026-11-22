namespace CheatLab.WifiStudio;

public sealed class WirelessNetwork
{
    public string Ssid { get; set; } = "";
    public string Bssid { get; set; } = "";
    public int Channel { get; set; }
    public string Band => Channel <= 14 ? "2,4 ГГц" : "5/6 ГГц";
    public int Signal { get; set; }
}

public sealed class WifiAdapter
{
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Status { get; set; } = "";
    public override string ToString() => $"{Name} · {Description}";
}

public sealed class AdapterSetting
{
    public string Adapter { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string RegistryKeyword { get; set; } = "";
    public string CurrentValue { get; set; } = "";
    public List<string> ValidValues { get; set; } = new();
    public override string ToString() => DisplayName;
}

public sealed class AppliedChange
{
    public string Adapter { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string RegistryKeyword { get; set; } = "";
    public string Before { get; set; } = "";
    public string After { get; set; } = "";
    public DateTime AppliedAtUtc { get; set; }
    public bool Reverted { get; set; }
}

public sealed class SpeedMeasurement
{
    public double DownloadMbps { get; set; }
    public double UploadMbps { get; set; }
    public double LatencyMs { get; set; }
}