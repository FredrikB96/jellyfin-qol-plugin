using Jellyfin.Plugin.QoL.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.QoL;

/// <summary>Registers QoL startup services with Jellyfin.</summary>
public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(
        IServiceCollection serviceCollection,
        IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<ClientBootstrapStatus>();
        serviceCollection.AddSingleton<ClientBootstrapRegistrationService>();
    }
}
