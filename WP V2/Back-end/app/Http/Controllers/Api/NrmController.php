<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Nrm;
use App\Support\OperativeAllocationNrms;
use App\Support\NrmCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NrmController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(['data' => $this->formatNrms(OperativeAllocationNrms::ordered())]);
    }

    public function store(Request $request): JsonResponse
    {
        $rawNumber = trim((string) ($request->input('number') ?? $request->input('nrmNumber') ?? ''));
        $number = NrmCatalog::canonicalNumber($rawNumber) ?? $rawNumber;

        $request->validate([
            'number' => 'sometimes|string|max:255',
            'nrmNumber' => 'sometimes|string|max:255',
        ]);

        if ($number === '') {
            return response()->json(['message' => 'Enter an NRM number.'], 422);
        }

        if (Nrm::query()->where('number', $number)->exists()) {
            return response()->json(['message' => 'That NRM section already exists.'], 422);
        }

        $nrm = Nrm::create([
            'number' => $number,
            'name' => $number,
            'sc_name' => $number,
        ]);

        return response()->json(['data' => $nrm, 'message' => 'NRM section added'], 201);
    }

    public function update(Request $request, Nrm $nrm): JsonResponse
    {
        $validated = $request->validate([
            'number' => 'required_without:nrmNumber|string|max:255|unique:nrms,number,'.$nrm->id,
            'nrmNumber' => 'required_without:number|string|max:255|unique:nrms,number,'.$nrm->id,
        ]);

        $number = $validated['number'] ?? $validated['nrmNumber'];
        $number = NrmCatalog::canonicalNumber($number) ?? $number;
        $nrm->update([
            'number' => $number,
            'name' => $nrm->name ?: $number,
            'sc_name' => $nrm->sc_name ?: $number,
        ]);

        return response()->json(['data' => $nrm, 'message' => 'NRM section updated']);
    }

    public function destroy(Nrm $nrm): JsonResponse
    {
        $nrm->delete();

        return response()->json(['message' => 'NRM section deleted']);
    }

    private function formatNrms($nrms): array
    {
        return $nrms->map(fn (Nrm $nrm) => [
            'id' => $nrm->id,
            'number' => $nrm->number,
            'name' => $nrm->name,
            'sc_name' => $nrm->sc_name,
            'pri' => $nrm->pri,
            'Name' => $nrm->name ?: $nrm->number,
            'Sc_Name' => $nrm->sc_name,
            'Pri' => $nrm->pri,
        ])->values()->all();
    }
}
