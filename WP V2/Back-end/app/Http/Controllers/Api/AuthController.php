<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function register(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'login_name' => 'required|string|max:100|unique:users,login_name',
            'email' => 'nullable|email|max:255|unique:users,email',
            'password' => 'required|string|min:6|confirmed',
        ]);

        $user = User::create([
            'name' => $validated['name'],
            'login_name' => $validated['login_name'],
            'email' => $validated['email'] ?? null,
            'password' => $validated['password'],
            'password_plain' => $validated['password'],
            'active' => true,
        ]);

        $token = $user->createToken('workplanner')->plainTextToken;

        return response()->json([
            'message' => 'Registration successful',
            'token' => $token,
            'user' => $user,
        ], 201);
    }

    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'login_name' => 'required|string|max:100',
            'password' => 'required|string',
        ]);

        $user = User::where('login_name', $validated['login_name'])
            ->where('active', true)
            ->first();

        if (! $user || ! Hash::check($validated['password'], $user->password)) {
            throw ValidationException::withMessages([
                'login_name' => ['The provided credentials are incorrect.'],
            ]);
        }

        $token = $user->createToken('workplanner')->plainTextToken;
        $user->load(['role.permissions']);

        return response()->json([
            'message' => 'Login successful',
            'token' => $token,
            'user' => $user,
        ]);
    }

    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()->delete();

        return response()->json(['message' => 'Logged out successfully']);
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user()->load(['role.permissions']);

        return response()->json(['user' => $user]);
    }
}
