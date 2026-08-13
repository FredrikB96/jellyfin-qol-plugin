using System;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.QoL.Services;

/// <summary>
/// Small per-user JSON document store.
///
/// The browser never supplies a target user id. The API controller resolves the
/// authenticated Jellyfin user and passes that id here, preventing one user from
/// selecting another user's QoL settings file.
/// </summary>
internal static class UserSettingsStore
{
    private const int CurrentSchemaVersion = 1;
    private static readonly ConcurrentDictionary<Guid, SemaphoreSlim> Locks = new();

    internal static async Task<string> ReadAsync(Guid userId, CancellationToken cancellationToken)
    {
        var path = GetPath(userId);
        var gate = Locks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(path))
            {
                return EmptyDocument();
            }

            var json = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
            return string.IsNullOrWhiteSpace(json) ? EmptyDocument() : json;
        }
        finally
        {
            gate.Release();
        }
    }

    internal static async Task WriteAsync(Guid userId, JsonElement data, int schemaVersion, CancellationToken cancellationToken)
    {
        if (schemaVersion < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(schemaVersion));
        }

        var path = GetPath(userId);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);

        var gate = Locks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                schemaVersion,
                data
            });

            var temp = path + ".tmp";
            await File.WriteAllTextAsync(temp, payload, new UTF8Encoding(false), cancellationToken).ConfigureAwait(false);
            File.Move(temp, path, true);
        }
        finally
        {
            gate.Release();
        }
    }

    internal static async Task DeleteAsync(Guid userId, CancellationToken cancellationToken)
    {
        var path = GetPath(userId);
        var gate = Locks.GetOrAdd(userId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private static string GetPath(Guid userId)
    {
        var plugin = Plugin.Instance ?? throw new InvalidOperationException("Jellyfin QoL plugin is not initialized.");
        return Path.Combine(plugin.DataFolderPath, "UserSettings", userId.ToString("N") + ".json");
    }

    private static string EmptyDocument()
        => JsonSerializer.Serialize(new { schemaVersion = CurrentSchemaVersion, data = new { } });
}
