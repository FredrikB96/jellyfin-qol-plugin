using System;
using System.Collections.Generic;
using System.Globalization;
using Jellyfin.Plugin.QoL.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.QoL;

/// <summary>Jellyfin QoL Plugin.</summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Stable plugin identifier. Never change this GUID.</summary>
    public static readonly Guid PluginId = Guid.Parse("829959a4-8720-4e78-9ed2-8c2d2bf7ff2a");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Jellyfin QoL Plugin";

    public override Guid Id => PluginId;

    /// <summary>
    /// Registers one administrator configuration page plus embedded user-page
    /// resources. Only the admin page is listed in Jellyfin's plugin settings.
    /// The user page is mounted under Profile -> Settings by the client bridge.
    /// </summary>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        var ns = GetType().Namespace;

        yield return new PluginPageInfo
        {
            Name = Name,
            DisplayName = Name,
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Configuration.configPage.html",
                ns)
        };

        yield return new PluginPageInfo
        {
            Name = "JellyfinQoLUserSettingsPage",
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Web.userSettingsPage.html",
                ns)
        };

        yield return new PluginPageInfo
        {
            Name = "JellyfinQoLUserSettingsPage.js",
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Web.userSettingsPage.js",
                ns)
        };

        yield return new PluginPageInfo
        {
            Name = "JellyfinQoLUserSettingsBridge.js",
            EmbeddedResourcePath = string.Format(
                CultureInfo.InvariantCulture,
                "{0}.Web.userSettingsBridge.js",
                ns)
        };
    }
}
