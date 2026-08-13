using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.QoL.Configuration;

/// <summary>
/// Administrator/global configuration for Jellyfin QoL.
///
/// Per-user settings are intentionally NOT stored here. They are owned by the
/// authenticated user-settings API and persisted separately per Jellyfin user.
/// Client-local enrollment/helper/HTPC state is stored in the browser/WebView.
/// </summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    public PluginConfiguration()
    {
        SchemaVersion = 2;
        SettingsJson = "{}";
    }

    /// <summary>Gets or sets the global settings schema version.</summary>
    public int SchemaVersion { get; set; }

    /// <summary>
    /// Gets or sets the server-global/default settings JSON document.
    /// Only administrators can read/write this through the plugin configuration page.
    /// </summary>
    public string SettingsJson { get; set; }
}
