<?php

namespace Database\Seeders;

use App\Models\TrainingCourse;
use Illuminate\Database\Seeder;

class TrainingCourseSeeder extends Seeder
{
    public function run(): void
    {
        $courses = [
            [
                'title' => 'BIM Level 2 Fundamentals',
                'course_link' => 'https://learn.example.com/bim-level-2',
                'description' => 'Group session covering BIM execution plans and common data environments.',
                'duration' => 'Multi-day',
                'hours_per_day' => 5.33,
                'priority' => 'P1',
                'urgency' => 'U2',
            ],
            [
                'title' => 'Health & Safety Refresher',
                'course_link' => 'https://learn.example.com/hs-refresher',
                'description' => 'Annual site safety and hazard awareness refresher.',
                'duration' => '1-2 hours',
                'hours_per_day' => 2,
                'priority' => 'P2',
                'urgency' => 'U1',
            ],
            [
                'title' => 'Revit Structure Advanced',
                'course_link' => 'https://learn.example.com/revit-structure',
                'description' => 'Advanced modelling workflows for structural deliverables.',
                'duration' => 'Full day',
                'hours_per_day' => 2.67,
                'priority' => 'P1',
                'urgency' => 'U1',
            ],
            [
                'title' => 'ISO 19650 Information Management',
                'course_link' => 'https://learn.example.com/iso-19650',
                'description' => 'Half-day overview of information requirements and exchange.',
                'duration' => 'Half day',
                'hours_per_day' => 4,
                'priority' => 'P2',
                'urgency' => 'U2',
            ],
            [
                'title' => 'Excel Power Query for QS',
                'course_link' => null,
                'description' => 'Short skills booster for quantity surveying spreadsheets.',
                'duration' => '2-4 hours',
                'hours_per_day' => 4,
                'priority' => 'P2',
                'urgency' => 'U1',
            ],
            [
                'title' => 'Leadership Skills Workshop',
                'course_link' => 'https://learn.example.com/leadership',
                'description' => 'Three-day workshop for senior NRM section operatives.',
                'duration' => 'Multi-day',
                'hours_per_day' => 5.33,
                'priority' => 'P1',
                'urgency' => 'U2',
            ],
            [
                'title' => 'AutoCAD Standards Update',
                'course_link' => 'https://learn.example.com/autocad-standards',
                'description' => 'Completed update on drawing standards and layer conventions.',
                'duration' => 'Full day',
                'hours_per_day' => 8,
                'priority' => 'P2',
                'urgency' => 'U1',
            ],
            [
                'title' => 'Mental Health First Aid',
                'course_link' => 'https://learn.example.com/mhfa',
                'description' => 'Half-day awareness training for workplace wellbeing.',
                'duration' => 'Half day',
                'hours_per_day' => 4,
                'priority' => 'P1',
                'urgency' => 'U1',
            ],
            [
                'title' => 'Navisworks Clash Detection',
                'course_link' => 'https://learn.example.com/navisworks-clash',
                'description' => 'Short practical session on clash review and reporting.',
                'duration' => '2-4 hours',
                'hours_per_day' => 4,
                'priority' => 'P1',
                'urgency' => 'U2',
            ],
            [
                'title' => 'Company Onboarding – TSA Tools',
                'course_link' => 'https://intranet.example.com/onboarding',
                'description' => 'Multi-day onboarding for NRM section operatives on internal tools.',
                'duration' => 'Multi-day',
                'hours_per_day' => 5.33,
                'priority' => 'P2',
                'urgency' => 'U1',
            ],
        ];

        foreach ($courses as $course) {
            TrainingCourse::query()->updateOrCreate(
                ['title' => $course['title']],
                $course,
            );
        }

        $this->command?->info('Seeded '.count($courses).' training courses.');
    }
}
