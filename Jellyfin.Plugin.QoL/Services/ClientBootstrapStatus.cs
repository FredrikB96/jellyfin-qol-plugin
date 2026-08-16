using System;

namespace Jellyfin.Plugin.QoL.Services;

/// <summary>Tracks how the browser bootstrap is being hosted for diagnostics.</summary>
public sealed class ClientBootstrapStatus
{
    private readonly object _sync = new();
    private ClientBootstrapStatusSnapshot _snapshot = new(
        false,
        "none",
        "Waiting for client bootstrap registration.",
        null,
        0);

    internal ClientBootstrapStatusSnapshot GetSnapshot()
    {
        lock (_sync)
        {
            return _snapshot;
        }
    }

    internal void Update(bool registered, string host, string message, int attempt)
    {
        lock (_sync)
        {
            _snapshot = new ClientBootstrapStatusSnapshot(
                registered,
                host,
                message,
                DateTimeOffset.UtcNow,
                attempt);
        }
    }
}

internal sealed record ClientBootstrapStatusSnapshot(
    bool Registered,
    string Host,
    string Message,
    DateTimeOffset? LastAttemptUtc,
    int Attempt);
