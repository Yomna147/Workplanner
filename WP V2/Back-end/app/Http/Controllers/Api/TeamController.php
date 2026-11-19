<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Team;
use App\Support\TeamOrder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class TeamController extends Controller
{
    public function index(): JsonResponse
    {
        $teams = Team::withCount(['employees', 'projects'])->get()
            ->sort(fn (Team $a, Team $b) => TeamOrder::compare($a->name, $b->name))
            ->values();

        return response()->json(['data' => $teams]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255|unique:teams,name',
        ]);

        $team = Team::create($validated);

        return response()->json(['data' => $team], 201);
    }

    public function update(Request $request, Team $team): JsonResponse
    {
        $validated = $request->validate([
            'name' => 'required|string|max:255|unique:teams,name,'.$team->id,
        ]);

        $team->update($validated);

        return response()->json(['data' => $team]);
    }

    public function destroy(Team $team): JsonResponse
    {
        $team->delete();

        return response()->json(['message' => 'Team deleted']);
    }
}
