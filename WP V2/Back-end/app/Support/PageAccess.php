<?php

namespace App\Support;

use App\Models\User;

class PageAccess
{
    /**
     * @param  list<array{0: string, 1?: string}|array{page: string, action?: string}>  $anyOf
     */
    public static function allows(?User $user, array $anyOf): bool
    {
        if (! $user) {
            return false;
        }

        return $user->canAnyPageAction($anyOf);
    }

    /**
     * @param  list<array{0: string, 1?: string}|array{page: string, action?: string}>  $anyOf
     */
    public static function assert(?User $user, array $anyOf, string $message = 'You do not have permission to perform this action.'): void
    {
        if (! self::allows($user, $anyOf)) {
            abort(403, $message);
        }
    }
}
