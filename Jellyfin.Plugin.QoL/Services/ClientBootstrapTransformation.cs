using System;

namespace Jellyfin.Plugin.QoL.Services;

/// <summary>Input supplied by the File Transformation plugin callback.</summary>
public sealed class ClientBootstrapTransformationPayload
{
    /// <summary>Gets or sets the current contents of the requested web file.</summary>
    public string Contents { get; set; } = string.Empty;
}

/// <summary>Creates the plugin-owned browser bootstrap injection.</summary>
public static class ClientBootstrapTransformation
{
    internal const string JavaScriptInjectorScriptId = "jellyfin-qol-client-bootstrap";
    internal const string FileTransformationHost = "file-transformation";
    internal const string JavaScriptInjectorHost = "javascript-injector";

    private const string BeginMarker = "<!-- BEGIN Jellyfin QoL Client Bootstrap -->";
    private const string EndMarker = "<!-- END Jellyfin QoL Client Bootstrap -->";
    private const string HostAttribute = "data-jellyfin-qol-bootstrap-host";

    internal const string LoaderScript = """
(() => {
    'use strict';

    const MARKER = 'jellyfin-qol-dll-client-bootstrap-loader';

    function load() {
        const runtime = window.JellyfinQoL?.clientBootstrap;
        if (runtime?.start) {
            runtime.start();
            return;
        }

        if (document.querySelector(`script[data-owner="${MARKER}"]`)) return;

        if (!window.ApiClient?.getUrl) {
            setTimeout(load, 250);
            return;
        }

        const script = document.createElement('script');
        script.dataset.owner = MARKER;
        script.src = ApiClient.getUrl('JellyfinQoL/Client/clientBootstrap.js') +
            `?qolhost=${encodeURIComponent(Date.now().toString())}`;
        script.async = true;
        script.onload = () => console.log('[JellyfinQoL] Plugin client bootstrap loaded.');
        script.onerror = error => console.error('[JellyfinQoL] Could not load plugin client bootstrap.', error);
        (document.head || document.documentElement).appendChild(script);
    }

    load();
})();
""";

    /// <summary>Adds the browser loader to Jellyfin Web's index page once.</summary>
    /// <param name="payload">The current index file contents.</param>
    /// <returns>The transformed index file.</returns>
    public static string TransformIndexHtml(ClientBootstrapTransformationPayload? payload)
    {
        var contents = payload?.Contents ?? string.Empty;

        // Defense in depth: never append HTML markup to a JavaScript or other
        // non-document response even if a host plugin calls this callback for
        // an unexpected filename.
        var documentStart = contents.TrimStart();
        var isHtmlDocument =
            documentStart.StartsWith("<!doctype html", StringComparison.OrdinalIgnoreCase) ||
            documentStart.StartsWith("<html", StringComparison.OrdinalIgnoreCase);
        var bodyIndex = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (!isHtmlDocument || bodyIndex < 0)
        {
            return contents;
        }

        if (contents.Contains(BeginMarker, StringComparison.Ordinal) ||
            contents.Contains(HostAttribute, StringComparison.Ordinal))
        {
            return contents;
        }

        var block = string.Concat(
            Environment.NewLine,
            BeginMarker,
            Environment.NewLine,
            "<script ",
            HostAttribute,
            "=\"file-transformation\">",
            Environment.NewLine,
            LoaderScript,
            Environment.NewLine,
            "</script>",
            Environment.NewLine,
            EndMarker,
            Environment.NewLine);

        return contents.Insert(bodyIndex, block);
    }
}
