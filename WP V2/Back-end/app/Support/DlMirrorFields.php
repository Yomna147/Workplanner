<?php

namespace App\Support;

use App\Models\ProjectTask;

class DlMirrorFields
{
  /** @var array<string, string> */
  private const MIRROR_FIELD_MAP = [
    'dl' => 'dl_dl',
    'rfi' => 'dl_rfi',
    'con' => 'dl_con',
    'override_1' => 'dl_override_1',
    'override_2' => 'dl_override_2',
    'override_3' => 'dl_override_3',
    'progress_updated' => 'dl_progress_updated',
    'progress_per' => 'dl_progress_per',
    'done' => 'dl_done',
    'owner' => 'dl_owner',
    'project_completion_date' => 'dl_project_completion_date',
  ];

  /** @param array<string, mixed> $task */
  public static function applyMirrorValuesToPde(array $task): array
  {
    foreach (self::MIRROR_FIELD_MAP as $field => $mirrorKey) {
      $mirrorValue = trim((string) ($task[$mirrorKey] ?? ''));
      if ($mirrorValue === '') {
        continue;
      }

      if ($field === 'rfi' || $field === 'done') {
        $task[$field] = in_array($mirrorValue, ['1', 'true', 'TRUE'], true);
        continue;
      }

      $task[$field] = $mirrorValue;
    }

    return $task;
  }

  /** @param array<string, mixed>|ProjectTask|null $task */
  public static function isOwnerLockedByDl(array|ProjectTask|null $task): bool
  {
    if ($task === null) {
      return false;
    }

    $dlOwner = $task instanceof ProjectTask
      ? $task->dl_owner
      : ($task['dl_owner'] ?? null);

    return $dlOwner !== null && trim((string) $dlOwner) !== '';
  }

  /**
   * Owner should not be overwritten by PDE auto-assign or algorithm when DL locked
   * or when a value is already stored.
   *
   * @param array<string, mixed>|ProjectTask|null $task
   */
  public static function shouldPreserveOwner(array|ProjectTask|null $task): bool
  {
    if (self::isOwnerLockedByDl($task)) {
      return true;
    }

    if ($task === null) {
      return false;
    }

    $owner = $task instanceof ProjectTask
      ? $task->owner
      : ($task['owner'] ?? $task['Owner'] ?? null);

    return $owner !== null && trim((string) $owner) !== '';
  }

  /**
   * DL page edits stamp dl_owner when the operative takes ownership.
   * Honour that update on save (not during algorithm runs).
   *
   * @param  array<string, mixed>  $payload
   */
  public static function payloadUpdatesDlOwner(array $payload, ?ProjectTask $existingTask = null): bool
  {
    $payloadDlOwner = trim((string) ($payload['dl_owner'] ?? ''));
    if ($payloadDlOwner === '') {
      return false;
    }

    $payloadOwner = trim((string) ($payload['owner'] ?? ''));

    // DL page stamps owner + dl_owner together (including hour-only edits).
    // Honour aligned claims even when dl_owner string is unchanged (re-edit).
    if ($payloadOwner !== '' && $payloadOwner === $payloadDlOwner) {
      return true;
    }

    if (! $existingTask instanceof ProjectTask) {
      return true;
    }

    $existingDlOwner = trim((string) ($existingTask->dl_owner ?? ''));

    return $payloadDlOwner !== $existingDlOwner;
  }

  /**
   * Stamp DL mirror columns for fields a DL just changed.
   *
   * @param  array<string, mixed>  $payload
   * @param  list<string>  $changedKeys
   * @return array<string, mixed>
   */
  public static function stampMirrorsForChangedFields(array $payload, array $changedKeys): array
  {
    foreach ($changedKeys as $field) {
      if (! isset(self::MIRROR_FIELD_MAP[$field]) || ! array_key_exists($field, $payload)) {
        continue;
      }

      $mirrorKey = self::MIRROR_FIELD_MAP[$field];
      $value = $payload[$field];

      if ($field === 'rfi' || $field === 'done') {
        $payload[$mirrorKey] = self::isTruthy($value) ? '1' : '0';
        continue;
      }

      $payload[$mirrorKey] = $value === null ? '' : (string) $value;
    }

    return $payload;
  }

  public static function isTruthy(mixed $value): bool
  {
    if (is_bool($value)) {
      return $value;
    }

    $normalized = strtolower(trim((string) ($value ?? '')));

    return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
  }
}
