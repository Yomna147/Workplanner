<?php

namespace Database\Seeders;

use App\Models\Employee;
use App\Models\Part;
use App\Models\Project;
use App\Models\ProjectTask;
use App\Models\Role;
use App\Models\Team;
use App\Models\User;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $this->call(RolePageSeeder::class);
        $this->call(EmailNotificationRuleSeeder::class);
        $this->call(NrmSeeder::class);
        $this->call(TsaTeamsEmployeesSeeder::class);
        $this->call(OapSeeder::class);

        \App\Support\EmployeeNames::syncAllTaskAssignees();

        $adminRole = Role::where('name', 'Administrator')->first();

        User::factory()->create([
            'name' => 'Admin User',
            'first_name' => 'Admin',
            'last_name' => 'User',
            'login_name' => 'admin',
            'email' => 'admin@workplanner.local',
            'password' => 'password',
            'password_plain' => 'password',
            'active' => true,
            'role_id' => $adminRole?->id,
            'is_admin' => true,
        ]);

        $teams = collect([
            Team::create(['name' => 'Alpha Team']),
            Team::create(['name' => 'Beta Team']),
        ]);

        $projectA = Project::create([
            'name' => 'Sample Project A',
            'color' => '#3B82F6',
            'status' => 'active',
            'description' => 'Starter project for Workplanner 2.0',
            'team_id' => $teams[0]->id,
        ]);

        $projectB = Project::create([
            'name' => 'Sample Project B',
            'color' => '#10B981',
            'status' => 'on_hold',
            'team_id' => $teams[1]->id,
        ]);

        Part::create(['project_id' => $projectA->id, 'name' => 'Main']);
        $partB1 = Part::create(['project_id' => $projectB->id, 'name' => 'Phase 1']);
        Part::create(['project_id' => $projectB->id, 'name' => 'Phase 2']);

        $mainPart = Part::where('project_id', $projectA->id)->where('name', 'Main')->first();

        ProjectTask::create([
            'part_id' => $mainPart->id,
            'task_name' => 'Site setup',
            'doc_supply' => now()->toDateString(),
            'completion' => now()->addDays(10)->toDateString(),
            'plan' => '24',
            'est' => '24',
            'pp' => '0.12',
            'rap' => '0.05',
            'pri' => '0.17',
            'override_1' => 'Mohamed Khaled',
            'progress_per' => '35',
        ]);

        ProjectTask::create([
            'part_id' => $partB1->id,
            'task_name' => 'Steel frame',
            'doc_supply' => now()->addDays(5)->toDateString(),
            'completion' => now()->addDays(20)->toDateString(),
            'plan' => '40',
            'est' => '40',
            'pp' => '0.06',
            'rap' => '0.08',
            'pri' => '0.14',
            'algorithm_1' => 'Mina Tarek',
            'progress_per' => '10',
        ]);

        $this->call(AlgorithmTestProjectsSeeder::class);
        $this->call(TrainingCourseSeeder::class);
        $this->call(SampleTrainingsSeeder::class);
    }
}
