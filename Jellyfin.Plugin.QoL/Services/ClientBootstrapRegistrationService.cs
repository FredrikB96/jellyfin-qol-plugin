using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.QoL.Services;

/// <summary>Registers the embedded browser bootstrap with a supported host plugin.</summary>
public sealed class ClientBootstrapRegistrationService : IScheduledTask
{
    private const int MaxAttempts = 10;
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(500);
    private readonly ClientBootstrapStatus _status;
    private readonly ILogger<ClientBootstrapRegistrationService> _logger;

    /// <summary>Initializes a new instance of the <see cref="ClientBootstrapRegistrationService"/> class.</summary>
    /// <param name="status">Shared client bootstrap diagnostics.</param>
    /// <param name="logger">Jellyfin logger.</param>
    public ClientBootstrapRegistrationService(
        ClientBootstrapStatus status,
        ILogger<ClientBootstrapRegistrationService> logger)
    {
        _status = status;
        _logger = logger;
    }

    /// <inheritdoc />
    public string Name => "Jellyfin QoL Client Bootstrap";

    /// <inheritdoc />
    public string Key => "JellyfinQoLClientBootstrap";

    /// <inheritdoc />
    public string Description => "Registers the QoL browser bootstrap with File Transformation or JavaScript Injector.";

    /// <inheritdoc />
    public string Category => "Jellyfin QoL";

    /// <inheritdoc />
    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        string lastMessage = "No supported client bootstrap host was detected.";

        for (int attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            progress.Report((attempt - 1) * 100d / MaxAttempts);
            _status.Update(false, "registering", "Looking for a supported client bootstrap host.", attempt);

            RegistrationAttempt fileTransformation = TryRegisterFileTransformation();
            if (fileTransformation.Success)
            {
                TryUnregisterJavaScriptInjectorScripts();
                _status.Update(true, ClientBootstrapTransformation.FileTransformationHost, fileTransformation.Message, attempt);
                _logger.LogInformation("{Message}", fileTransformation.Message);
                progress.Report(100);
                return;
            }

            RegistrationAttempt javaScriptInjector = fileTransformation.Found && attempt < MaxAttempts
                ? RegistrationAttempt.NotFound("JavaScript Injector fallback is waiting for File Transformation retries.")
                : TryRegisterJavaScriptInjector();
            if (javaScriptInjector.Success)
            {
                _status.Update(true, ClientBootstrapTransformation.JavaScriptInjectorHost, javaScriptInjector.Message, attempt);
                _logger.LogInformation("{Message}", javaScriptInjector.Message);
                progress.Report(100);
                return;
            }

            lastMessage = DescribeUnavailableHosts(fileTransformation, javaScriptInjector);
            if (attempt < MaxAttempts)
            {
                await Task.Delay(RetryDelay, cancellationToken).ConfigureAwait(false);
            }
        }

        _status.Update(false, "none", lastMessage, MaxAttempts);
        _logger.LogError(
            "Jellyfin QoL client runtime is inactive. Install and enable either File Transformation or JavaScript Injector, then restart Jellyfin. {Details}",
            lastMessage);
        progress.Report(100);
    }

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        return new[]
        {
            new TaskTriggerInfo
            {
                Type = TaskTriggerInfoType.StartupTrigger
            }
        };
    }

    private static RegistrationAttempt TryRegisterFileTransformation()
    {
        const string interfaceName = "Jellyfin.Plugin.FileTransformation.PluginInterface";
        Type? interfaceType = FindLoadedType(interfaceName);
        if (interfaceType is null)
        {
            return RegistrationAttempt.NotFound("File Transformation is not loaded.");
        }

        try
        {
            MethodInfo method = interfaceType.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static)
                ?? throw new MissingMethodException(interfaceName, "RegisterTransformation");
            object payload = CreateForeignJObject(method, new
            {
                id = Plugin.PluginId,
                // Use the host's canonical literal key so this callback joins
                // the same index pipeline as other plugins. File Transformation
                // also evaluates literal keys as regular expressions for
                // non-exact paths, so TransformIndexHtml must independently
                // reject every payload that is not an HTML document.
                fileNamePattern = "index.html",
                callbackAssembly = typeof(ClientBootstrapTransformation).Assembly.FullName,
                callbackClass = typeof(ClientBootstrapTransformation).FullName,
                callbackMethod = nameof(ClientBootstrapTransformation.TransformIndexHtml)
            });

            method.Invoke(null, new[] { payload });
            return RegistrationAttempt.Registered(
                "Jellyfin QoL client bootstrap registered through File Transformation.");
        }
        catch (Exception exception)
        {
            return RegistrationAttempt.Failed(
                "File Transformation registration failed: " + UnwrapMessage(exception));
        }
    }

    private static RegistrationAttempt TryRegisterJavaScriptInjector()
    {
        const string interfaceName = "Jellyfin.Plugin.JavaScriptInjector.PluginInterface";
        Type? interfaceType = FindLoadedType(interfaceName);
        if (interfaceType is null)
        {
            return RegistrationAttempt.NotFound("JavaScript Injector is not loaded.");
        }

        try
        {
            MethodInfo method = interfaceType.GetMethod("RegisterScript", BindingFlags.Public | BindingFlags.Static)
                ?? throw new MissingMethodException(interfaceName, "RegisterScript");
            object payload = CreateForeignJObject(method, new
            {
                id = ClientBootstrapTransformation.JavaScriptInjectorScriptId,
                name = "Jellyfin QoL Client Bootstrap",
                script = ClientBootstrapTransformation.LoaderScript,
                enabled = true,
                requiresAuthentication = false,
                pluginId = Plugin.PluginId.ToString(),
                pluginName = Plugin.Instance?.Name ?? "Jellyfin QoL Plugin",
                pluginVersion = typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "unknown"
            });

            object? result = method.Invoke(null, new[] { payload });
            if (result is not true)
            {
                return RegistrationAttempt.Failed("JavaScript Injector rejected the QoL bootstrap registration.");
            }

            return RegistrationAttempt.Registered(
                "Jellyfin QoL client bootstrap registered through JavaScript Injector.");
        }
        catch (Exception exception)
        {
            return RegistrationAttempt.Failed(
                "JavaScript Injector registration failed: " + UnwrapMessage(exception));
        }
    }

    internal static void TryUnregisterJavaScriptInjectorScripts()
    {
        const string interfaceName = "Jellyfin.Plugin.JavaScriptInjector.PluginInterface";
        try
        {
            Type? interfaceType = FindLoadedType(interfaceName);
            MethodInfo? method = interfaceType?.GetMethod("UnregisterAllScriptsFromPlugin", BindingFlags.Public | BindingFlags.Static);
            method?.Invoke(null, new object[] { Plugin.PluginId.ToString() });
        }
        catch
        {
            // File Transformation already owns the active bootstrap. Stale
            // JavaScript Injector cleanup is best effort only.
        }
    }

    private static object CreateForeignJObject(MethodInfo method, object value)
    {
        ParameterInfo[] parameters = method.GetParameters();
        if (parameters.Length != 1)
        {
            throw new InvalidOperationException($"{method.DeclaringType?.FullName}.{method.Name} has an unsupported signature.");
        }

        Type payloadType = parameters[0].ParameterType;
        MethodInfo parse = payloadType.GetMethod(
            "Parse",
            BindingFlags.Public | BindingFlags.Static,
            null,
            new[] { typeof(string) },
            null)
            ?? throw new MissingMethodException(payloadType.FullName, "Parse");
        string json = JsonSerializer.Serialize(value);
        return parse.Invoke(null, new object[] { json })
            ?? throw new InvalidOperationException($"Could not create {payloadType.FullName}.");
    }

    private static Type? FindLoadedType(string fullName)
    {
        return AssemblyLoadContext.All
            .SelectMany(context => context.Assemblies)
            .Select(assembly => assembly.GetType(fullName, false))
            .FirstOrDefault(type => type is not null);
    }

    private static string DescribeUnavailableHosts(
        RegistrationAttempt fileTransformation,
        RegistrationAttempt javaScriptInjector)
    {
        return string.Join(" ", new[] { fileTransformation.Message, javaScriptInjector.Message });
    }

    private static string UnwrapMessage(Exception exception)
    {
        return exception is TargetInvocationException { InnerException: not null }
            ? exception.InnerException.Message
            : exception.Message;
    }

    private sealed record RegistrationAttempt(bool Found, bool Success, string Message)
    {
        public static RegistrationAttempt NotFound(string message) => new(false, false, message);

        public static RegistrationAttempt Failed(string message) => new(true, false, message);

        public static RegistrationAttempt Registered(string message) => new(true, true, message);
    }
}
