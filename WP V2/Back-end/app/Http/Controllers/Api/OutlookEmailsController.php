<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\OutlookGraphService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

class OutlookEmailsController extends Controller
{
    public function __construct(
        private readonly OutlookGraphService $outlook,
    ) {}

    public function index(Request $request): JsonResponse
    {
        @set_time_limit(120);

        $validated = $request->validate([
            'profile' => 'nullable|in:deals,leads',
            'filter' => 'nullable|in:all,order_confirmation,quotations,order_and_quotations',
            'search' => 'nullable|string|max:200',
            'top' => 'nullable|integer|min:1|max:100',
        ]);

        try {
            $payload = $this->outlook->listMessages(
                profile: $validated['profile'] ?? 'deals',
                filter: $validated['filter'] ?? 'order_and_quotations',
                top: (int) ($validated['top'] ?? 80),
                search: $validated['search'] ?? null,
            );

            return response()->json(['data' => $payload]);
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to load Outlook emails: '.$e->getMessage(),
            ], 502);
        }
    }

    /**
     * Order Confirmation + Quotation form projects that are not yet in Work Planner.
     */
    public function awaitingProjects(Request $request): JsonResponse
    {
        @set_time_limit(120);

        $validated = $request->validate([
            'profile' => 'nullable|in:deals,leads',
            'top' => 'nullable|integer|min:1|max:100',
        ]);

        try {
            $payload = $this->outlook->listAwaitingConfirmationCandidates(
                profile: $validated['profile'] ?? 'deals',
                top: (int) ($validated['top'] ?? 80),
            );

            return response()->json($payload);
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to load awaiting Outlook projects: '.$e->getMessage(),
            ], 502);
        }
    }

    public function show(Request $request): JsonResponse
    {
        @set_time_limit(90);

        $validated = $request->validate([
            'profile' => 'nullable|in:deals,leads',
            'id' => 'required|string|max:2048',
        ]);

        try {
            $message = $this->outlook->getMessage(
                $validated['profile'] ?? 'deals',
                $validated['id'],
            );

            return response()->json(['data' => $message]);
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);

            return response()->json([
                'message' => 'Unable to load Outlook message: '.$e->getMessage(),
            ], 502);
        }
    }

    public function attachment(Request $request): StreamedResponse|JsonResponse
    {
        @set_time_limit(90);

        $validated = $request->validate([
            'profile' => 'nullable|in:deals,leads',
            'id' => 'required|string|max:2048',
            'attachment_id' => 'required|string|max:2048',
        ]);

        try {
            $file = $this->outlook->getAttachment(
                $validated['profile'] ?? 'deals',
                $validated['id'],
                $validated['attachment_id'],
            );

            $filename = str_replace(['"', "\r", "\n"], '', $file['name']);
            $contentType = $file['content_type'];
            $binary = $file['content'];

            return response()->streamDownload(
                static function () use ($binary): void {
                    echo $binary;
                },
                $filename,
                [
                    'Content-Type' => $contentType,
                    'Content-Length' => (string) strlen($binary),
                    'Cache-Control' => 'private, max-age=60',
                ]
            );
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        } catch (Throwable $e) {
            report($e);

            return response()->json(['message' => 'Unable to download Outlook attachment.'], 502);
        }
    }
}
