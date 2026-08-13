using System;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.QoL.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.QoL.Api;

/// <summary>Authenticated per-user Jellyfin QoL settings API.</summary>
[ApiController]
[Authorize]
[Route("JellyfinQoL/UserSettings")]
public sealed class UserSettingsController : ControllerBase
{
    /// <summary>
    /// Gets the current authenticated user's QoL settings plus the server-global
    /// defaults that should be used as the user's baseline.
    /// </summary>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult> Get(CancellationToken cancellationToken)
    {
        var userId = GetAuthenticatedUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        var userJson = await UserSettingsStore.ReadAsync(userId, cancellationToken).ConfigureAwait(false);
        var userDocument = ParseClone(userJson, "{\"schemaVersion\":1,\"data\":{}}");

        var globalRaw = Plugin.Instance?.Configuration.SettingsJson ?? "{}";
        var globalDocument = ParseClone(globalRaw, "{}");

        return Ok(new
        {
            user = userDocument,
            global = globalDocument
        });
    }

    /// <summary>Saves the current authenticated user's QoL settings document.</summary>
    [HttpPut]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> Put([FromBody] UserSettingsWriteRequest request, CancellationToken cancellationToken)
    {
        var userId = GetAuthenticatedUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        if (request.SchemaVersion < 1)
        {
            return BadRequest("schemaVersion must be >= 1.");
        }

        await UserSettingsStore.WriteAsync(userId, request.Data, request.SchemaVersion, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    /// <summary>Resets the current authenticated user's QoL settings.</summary>
    [HttpDelete]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> Delete(CancellationToken cancellationToken)
    {
        var userId = GetAuthenticatedUserId();
        if (userId == Guid.Empty)
        {
            return Unauthorized();
        }

        await UserSettingsStore.DeleteAsync(userId, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }


    private Guid GetAuthenticatedUserId()
    {
        // Jellyfin 10.11 stores the authenticated user id in the
        // "Jellyfin-UserId" claim. We intentionally read the claim directly
        // instead of depending on Jellyfin.Api.Extensions so the plugin only
        // needs the normal Jellyfin.Controller/Model package references.
        var value = User.Claims
            .FirstOrDefault(claim => string.Equals(
                claim.Type,
                "Jellyfin-UserId",
                StringComparison.OrdinalIgnoreCase))
            ?.Value;

        return Guid.TryParse(value, out var userId)
            ? userId
            : Guid.Empty;
    }

    private static JsonElement ParseClone(string value, string fallback)
    {
        try
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(value) ? fallback : value);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            using var document = JsonDocument.Parse(fallback);
            return document.RootElement.Clone();
        }
    }
}

/// <summary>Write payload for current-user QoL settings.</summary>
public sealed class UserSettingsWriteRequest
{
    /// <summary>Gets or sets the user settings schema version.</summary>
    public int SchemaVersion { get; set; } = 1;

    /// <summary>Gets or sets the user settings data.</summary>
    public JsonElement Data { get; set; }
}
