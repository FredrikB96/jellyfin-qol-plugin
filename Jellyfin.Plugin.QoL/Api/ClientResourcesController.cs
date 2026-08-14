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
            ["recordInput.js"] = "Jellyfin.Plugin.QoL.Web.recordInput.js"
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
            using (stream)
            using (var reader = new StreamReader(stream))
            {
                var bootstrap = reader.ReadToEnd();
                return Content(bootstrap + RecordInputAutoload, "text/javascript; charset=utf-8");
            }
        }

        return File(stream, "text/javascript; charset=utf-8");
    }
}
