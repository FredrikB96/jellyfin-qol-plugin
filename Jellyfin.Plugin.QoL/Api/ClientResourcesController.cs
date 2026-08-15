using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.QoL.Api;

/// <summary>
/// Serves a small allow-list of JavaScript resources embedded in the QoL DLL.
/// This avoids registering every runtime module as a Jellyfin configuration page
/// and gives the production client bootstrap one stable resource endpoint.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("JellyfinQoL/Client")]
public sealed class ClientResourcesController : ControllerBase
{
    private static readonly IReadOnlyDictionary<string, string> Resources =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["clientBootstrap.js"] = "Jellyfin.Plugin.QoL.Web.clientBootstrap.js",
            ["runtimeSettings.js"] = "Jellyfin.Plugin.QoL.Web.runtimeSettings.js",
            ["userSettingsBridge.js"] = "Jellyfin.Plugin.QoL.Web.userSettingsBridge.js",
            ["userSettingsKeybindIntegration.js"] = "Jellyfin.Plugin.QoL.Web.userSettingsKeybindIntegration.js",
            ["recordInput.js"] = "Jellyfin.Plugin.QoL.Web.recordInput.js",
            ["inputRegistry.js"] = "Jellyfin.Plugin.QoL.Web.inputRegistry.js",
            ["gestureResolver.js"] = "Jellyfin.Plugin.QoL.Web.gestureResolver.js",
            ["gestureResolverDirectionalPolicy.js"] = "Jellyfin.Plugin.QoL.Web.gestureResolverDirectionalPolicy.js",
            ["universalInput.js"] = "Jellyfin.Plugin.QoL.Web.universalInput.js",
            ["controlBridge.js"] = "Jellyfin.Plugin.QoL.Web.controlBridge.js",
            ["guardManager.js"] = "Jellyfin.Plugin.QoL.Web.guardManager.js",
            ["navigationScanner.js"] = "Jellyfin.Plugin.QoL.Web.navigationScanner.js",
            ["navigationFocus.js"] = "Jellyfin.Plugin.QoL.Web.navigationFocus.js",
            ["navigationGeometry.js"] = "Jellyfin.Plugin.QoL.Web.navigationGeometry.js",
            ["navigationController.js"] = "Jellyfin.Plugin.QoL.Web.navigationController.js",
            ["launcherRuntime.js"] = "Jellyfin.Plugin.QoL.Web.launcherRuntime.js"
        };

    private const string RecordInputAutoload = """

;(function () {
    'use strict';

    const MODULE_ID = 'recordInput';

    function loadRecordInput() {
        const QoL = window.JellyfinQoL = window.JellyfinQoL || {};
        if (QoL.recordInputRuntime) return;
        if (document.querySelector(`script[data-jellyfin-qol-module="${MODULE_ID}"]`)) return;

        if (!window.ApiClient?.getUrl) {
            setTimeout(loadRecordInput, 100);
            return;
        }

        const script = document.createElement('script');
        script.async = false;
        script.dataset.jellyfinQolModule = MODULE_ID;
        script.src = ApiClient.getUrl('JellyfinQoL/Client/recordInput.js') +
            `?qolrecord=${encodeURIComponent(Date.now().toString())}`;
        script.onload = () => console.log('[JellyfinQoL.ClientBootstrap] Module ready: recordInput');
        script.onerror = error => console.error('[JellyfinQoL.ClientBootstrap] Failed to load recordInput.', error);
        document.head.appendChild(script);
    }

    if (window.JellyfinQoL?.clientReady) {
        loadRecordInput();
        return;
    }

    window.addEventListener('jellyfin-qol-client-ready', loadRecordInput, { once:true });
})();
""";

    /// <summary>Returns an embedded client JavaScript module by allow-listed name.</summary>
    /// <param name="name">Allow-listed resource file name.</param>
    /// <returns>The embedded JavaScript resource.</returns>
    [HttpGet("{name}")]
    [Produces("text/javascript")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult Get(string name)
    {
        if (!Resources.TryGetValue(name, out var manifestResourceName))
        {
            return NotFound();
        }

        var stream = typeof(Plugin).Assembly.GetManifestResourceStream(manifestResourceName);
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        Response.Headers.Expires = "0";

        if (name.Equals("clientBootstrap.js", StringComparison.OrdinalIgnoreCase))
        {
            var inputRegistryStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["inputRegistry.js"]);
            var gestureResolverStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["gestureResolver.js"]);
            var directionalPolicyStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["gestureResolverDirectionalPolicy.js"]);
            var universalInputStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["universalInput.js"]);
            var controlBridgeStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["controlBridge.js"]);
            var guardManagerStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["guardManager.js"]);
            var navigationScannerStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["navigationScanner.js"]);
            var navigationFocusStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["navigationFocus.js"]);
            var navigationGeometryStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["navigationGeometry.js"]);
            var navigationControllerStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["navigationController.js"]);
            var launcherRuntimeStream = typeof(Plugin).Assembly.GetManifestResourceStream(Resources["launcherRuntime.js"]);
            if (inputRegistryStream is null || gestureResolverStream is null || directionalPolicyStream is null || universalInputStream is null || controlBridgeStream is null || guardManagerStream is null || navigationScannerStream is null || navigationFocusStream is null || navigationGeometryStream is null || navigationControllerStream is null || launcherRuntimeStream is null)
            {
                stream.Dispose();
                inputRegistryStream?.Dispose();
                gestureResolverStream?.Dispose();
                directionalPolicyStream?.Dispose();
                universalInputStream?.Dispose();
                controlBridgeStream?.Dispose();
                guardManagerStream?.Dispose();
                navigationScannerStream?.Dispose();
                navigationFocusStream?.Dispose();
                navigationGeometryStream?.Dispose();
                navigationControllerStream?.Dispose();
                launcherRuntimeStream?.Dispose();
                return NotFound();
            }

            using (stream)
            using (inputRegistryStream)
            using (gestureResolverStream)
            using (directionalPolicyStream)
            using (universalInputStream)
            using (controlBridgeStream)
            using (guardManagerStream)
            using (navigationScannerStream)
            using (navigationFocusStream)
            using (navigationGeometryStream)
            using (navigationControllerStream)
            using (launcherRuntimeStream)
            using (var bootstrapReader = new StreamReader(stream))
            using (var inputRegistryReader = new StreamReader(inputRegistryStream))
            using (var gestureResolverReader = new StreamReader(gestureResolverStream))
            using (var directionalPolicyReader = new StreamReader(directionalPolicyStream))
            using (var universalInputReader = new StreamReader(universalInputStream))
            using (var controlBridgeReader = new StreamReader(controlBridgeStream))
            using (var guardManagerReader = new StreamReader(guardManagerStream))
            using (var navigationScannerReader = new StreamReader(navigationScannerStream))
            using (var navigationFocusReader = new StreamReader(navigationFocusStream))
            using (var navigationGeometryReader = new StreamReader(navigationGeometryStream))
            using (var navigationControllerReader = new StreamReader(navigationControllerStream))
            using (var launcherRuntimeReader = new StreamReader(launcherRuntimeStream))
            {
                var inputRegistry = inputRegistryReader.ReadToEnd();
                var gestureResolver = gestureResolverReader.ReadToEnd();
                var directionalPolicy = directionalPolicyReader.ReadToEnd();
                var universalInput = universalInputReader.ReadToEnd();
                var controlBridge = controlBridgeReader.ReadToEnd();
                var guardManager = guardManagerReader.ReadToEnd();
                var navigationScanner = navigationScannerReader.ReadToEnd();
                var navigationFocus = navigationFocusReader.ReadToEnd();
                var navigationGeometry = navigationGeometryReader.ReadToEnd();
                var navigationController = navigationControllerReader.ReadToEnd();
                var bootstrap = bootstrapReader.ReadToEnd();
                var launcherRuntime = launcherRuntimeReader.ReadToEnd();
                return Content(
                    inputRegistry + "\n" +
                    gestureResolver + "\n" +
                    directionalPolicy + "\n" +
                    universalInput + "\n" +
                    controlBridge + "\n" +
                    guardManager + "\n" +
                    navigationScanner + "\n" +
                    navigationFocus + "\n" +
                    navigationGeometry + "\n" +
                    navigationController + "\n" +
                    bootstrap + "\n" +
                    launcherRuntime + RecordInputAutoload,
                    "text/javascript; charset=utf-8");
            }
        }

        return File(stream, "text/javascript; charset=utf-8");
    }
}

