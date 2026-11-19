<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\EmailNotificationRule;
use App\Models\Role;
use App\Models\User;
use App\Services\EmailNotificationService;
use App\Support\EmailNotificationCaseTypes;
use App\Support\PageAccess;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class EmailNotificationRuleController extends Controller
{
    public function __construct(
        private EmailNotificationService $notifications,
    ) {}

    public function index(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'view']]);

        $rules = EmailNotificationRule::query()
            ->orderBy('sort_order')
            ->orderBy('id')
            ->get();

        $users = User::query()
            ->where('active', true)
            ->orderBy('first_name')
            ->orderBy('last_name')
            ->get(['id', 'first_name', 'last_name', 'login_name', 'email', 'name', 'role_id']);

        $roles = Role::query()
            ->orderBy('name')
            ->get(['id', 'name']);

        return response()->json([
            'data' => [
                'settings' => [
                    'email_enabled' => $this->notifications->isGlobalEmailEnabled(),
                    'from_email' => $this->notifications->getStoredFromEmail(),
                    'default_from_email' => EmailNotificationService::normalizeEmail(config('mail.from.address')),
                ],
                'case_types' => EmailNotificationCaseTypes::all(),
                'built_in_case_types' => EmailNotificationCaseTypes::builtIn(),
                'rules' => $rules,
                'roles' => $roles->map(fn (Role $role) => [
                    'id' => $role->id,
                    'name' => $role->name,
                ]),
                'users' => $users->map(fn (User $user) => [
                    'id' => $user->id,
                    'name' => trim(($user->first_name ?? '').' '.($user->last_name ?? '')) ?: $user->name,
                    'login_name' => $user->login_name,
                    'email' => $user->email,
                    'role_id' => $user->role_id,
                ]),
            ],
        ]);
    }

    public function storeCaseType(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);

        $validated = $request->validate([
            'label' => 'required|string|max:255',
            'evaluator' => ['required', Rule::in(EmailNotificationCaseTypes::builtInValues())],
            'default' => 'nullable|numeric|min:0|max:1000',
            'description' => 'nullable|string|max:2000',
            'help' => 'nullable|string|max:4000',
        ]);

        try {
            $case = EmailNotificationCaseTypes::createCustom($validated);
        } catch (\InvalidArgumentException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json([
            'message' => 'Case added to the dropdown.',
            'data' => [
                'case_type' => $case,
                'case_types' => EmailNotificationCaseTypes::all(),
            ],
        ], 201);
    }

    public function updateCaseType(Request $request, string $caseType): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);

        $validated = $request->validate([
            'label' => 'sometimes|required|string|max:255',
            'default' => 'nullable|numeric|min:0|max:1000',
            'description' => 'nullable|string|max:2000',
            'help' => 'nullable|string|max:4000',
        ]);

        try {
            $case = EmailNotificationCaseTypes::updateCustom($caseType, $validated);
        } catch (\InvalidArgumentException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json([
            'message' => 'Case updated.',
            'data' => [
                'case_type' => $case,
                'case_types' => EmailNotificationCaseTypes::all(),
            ],
        ]);
    }

    public function destroyCaseType(Request $request, string $caseType): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);

        if (! str_starts_with($caseType, 'custom_')) {
            return response()->json(['message' => 'Built-in cases cannot be deleted.'], 422);
        }

        $inUse = EmailNotificationRule::query()->where('case_type', $caseType)->exists();
        if ($inUse) {
            return response()->json([
                'message' => 'This case is used by a notification rule. Change or delete those rules first.',
            ], 422);
        }

        EmailNotificationCaseTypes::deleteCustom($caseType);

        return response()->json([
            'message' => 'Case removed.',
            'data' => [
                'case_types' => EmailNotificationCaseTypes::all(),
            ],
        ]);
    }

    public function updateSettings(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);
        $this->normalizeEmailInputs($request, ['from_email']);

        $validated = $request->validate([
            'email_enabled' => 'required|boolean',
            'from_email' => 'nullable|email|max:255',
        ]);

        $this->notifications->updateGlobalSettings([
            'email_enabled' => $validated['email_enabled'],
            'from_email' => $validated['from_email'] ?? '',
        ]);

        return response()->json([
            'message' => 'Email notification settings saved.',
            'data' => [
                'email_enabled' => $validated['email_enabled'],
                'from_email' => trim((string) ($validated['from_email'] ?? '')),
            ],
        ]);
    }

    public function sendTestEmail(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);
        $this->normalizeEmailInputs($request, ['recipient_email', 'from_email']);

        $validated = $request->validate([
            'recipient_email' => 'nullable|email|max:255',
            'from_email' => 'nullable|email|max:255',
        ]);

        $recipient = trim((string) ($validated['recipient_email'] ?? $request->user()?->email ?? ''));
        if ($recipient === '' || ! filter_var($recipient, FILTER_VALIDATE_EMAIL)) {
            return response()->json([
                'message' => 'Enter a valid recipient email or add an email to your user account.',
            ], 422);
        }

        try {
            $result = $this->notifications->sendTestEmail(
                $recipient,
                isset($validated['from_email']) ? trim((string) $validated['from_email']) : null,
            );

            $message = $result['mailer'] === 'log'
                ? "Test email written to the server log (MAIL_MAILER=log). From: {$result['from']}."
                : "Test email sent to {$result['recipient']} from {$result['from']}.";

            return response()->json([
                'message' => $message,
                'data' => $result,
            ]);
        } catch (\InvalidArgumentException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            return response()->json([
                'message' => 'Failed to send test email: '.$exception->getMessage(),
            ], 500);
        }
    }

    public function store(Request $request): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);
        $validated = $this->validateRule($request);
        $this->syncRecipientFields($validated);

        $rule = EmailNotificationRule::create($validated);

        return response()->json(['data' => $rule], 201);
    }

    public function update(Request $request, EmailNotificationRule $emailNotificationRule): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);
        $validated = $this->validateRule($request, $emailNotificationRule->id);
        $this->syncRecipientFields($validated);

        $emailNotificationRule->update($validated);

        return response()->json(['data' => $emailNotificationRule->fresh()]);
    }

    public function destroy(Request $request, EmailNotificationRule $emailNotificationRule): JsonResponse
    {
        PageAccess::assert($request->user(), [['Email Notifications', 'manage_rules']]);
        $emailNotificationRule->delete();

        return response()->json(['message' => 'Rule deleted.']);
    }

    private function validateRule(Request $request, ?int $ignoreId = null): array
    {
        $this->normalizeEmailInputs($request, ['recipient_emails']);

        return $request->validate([
            'code' => [
                'required',
                'string',
                'max:64',
                Rule::unique('email_notification_rules', 'code')->ignore($ignoreId),
            ],
            'label' => 'required|string|max:255',
            'description' => 'nullable|string|max:2000',
            'case_type' => ['required', Rule::in(EmailNotificationCaseTypes::values())],
            'case_value' => 'required|numeric|min:0|max:1000',
            'enabled' => 'required|boolean',
            'in_app_enabled' => 'required|boolean',
            'email_enabled' => 'required|boolean',
            'recipient_user_ids' => 'nullable|array',
            'recipient_user_ids.*' => 'integer|exists:users,id',
            'recipient_emails' => 'nullable|array',
            'recipient_emails.*' => 'nullable|email|max:255',
            'recipient_names' => 'nullable|array',
            'recipient_names.*' => 'nullable|string|max:255',
            'recipient_role_ids' => 'nullable|array',
            'recipient_role_ids.*' => 'integer|exists:roles,id',
            'sort_order' => 'nullable|integer|min:0|max:9999',
        ]);
    }

    /** @param array<string, mixed> $validated */
    private function syncRecipientFields(array &$validated): void
    {
        $userIds = collect($validated['recipient_user_ids'] ?? [])
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        $validated['recipient_user_ids'] = $userIds;
        // Rules trigger from task data (case), not from who saved. Keep column cleared.
        $validated['for_role_ids'] = [];
        $validated['recipient_role_ids'] = collect($validated['recipient_role_ids'] ?? [])
            ->map(fn ($id) => (int) $id)
            ->filter(fn ($id) => $id > 0)
            ->unique()
            ->values()
            ->all();

        if ($userIds !== []) {
            $users = User::query()
                ->whereIn('id', $userIds)
                ->get();
            $validated['recipient_names'] = $users
                ->map(fn (User $user) => trim($user->first_name ?: $user->name ?: ''))
                ->filter()
                ->values()
                ->all();
            $validated['recipient_emails'] = $users
                ->map(fn (User $user) => EmailNotificationService::normalizeEmail($user->email))
                ->filter(fn (string $email) => $email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL))
                ->values()
                ->all();
        } else {
            $validated['recipient_names'] = collect($validated['recipient_names'] ?? [])
                ->map(fn ($name) => trim((string) $name))
                ->filter()
                ->values()
                ->all();
        }

        $validated['recipient_emails'] = collect($validated['recipient_emails'] ?? [])
            ->map(fn ($email) => EmailNotificationService::normalizeEmail($email))
            ->filter(fn (string $email) => $email !== '')
            ->values()
            ->all();
    }

    private function normalizeEmailInputs(Request $request, array $keys): void
    {
        foreach ($keys as $key) {
            if (! $request->has($key)) {
                continue;
            }

            $value = $request->input($key);
            if (is_array($value)) {
                $request->merge([
                    $key => array_map(
                        fn ($entry) => EmailNotificationService::normalizeEmail($entry) ?: null,
                        $value,
                    ),
                ]);
                continue;
            }

            $normalized = EmailNotificationService::normalizeEmail($value);
            $request->merge([$key => $normalized === '' ? null : $normalized]);
        }
    }
}
