<?php

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias([
            'page' => \App\Http\Middleware\EnsurePagePermission::class,
            'sales_tool' => \App\Http\Middleware\EnsureSalesToolIntegration::class,
        ]);

        $middleware->redirectGuestsTo(function (Request $request) {
            if ($request->is('api/*') || $request->expectsJson()) {
                return null;
            }

            return '/login';
        });
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(function (Request $request, \Throwable $e) {
            return $request->is('api/*') || $request->expectsJson();
        });

        $exceptions->render(function (\Throwable $e, Request $request) {
            if (! $request->is('api/*') && ! $request->expectsJson()) {
                return null;
            }

            if ($e instanceof ValidationException) {
                return null;
            }

            if ($e instanceof QueryException || $e instanceof PDOException) {
                report($e);

                $message = 'A database error occurred. Please try again later.';
                $status = Response::HTTP_SERVICE_UNAVAILABLE;

                $raw = $e->getMessage();
                if (str_contains($raw, 'actively refused') || str_contains($raw, 'Connection refused')) {
                    $message = 'The application cannot connect to the database right now. Please try again later.';
                }

                return response()->json(['message' => $message], $status);
            }

            return null;
        });
    })->create();
