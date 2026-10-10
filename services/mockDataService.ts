
import { JournalEntry } from "../types";

export type Scenario = 'balanced' | 'struggling' | 'high-achiever' | 'emotional';

export const generateScenarioData = (scenario: Scenario): JournalEntry[] => {
  const baseDate = new Date().toISOString().split('T')[0];
  
  const scenarios: Record<Scenario, JournalEntry[]> = {
    'struggling': [
      {
        studentId: 's1',
        studentName: 'Alex Rivera',
        pageId: 'p1',
        pageTitle: 'Reflection Week 4',
        date: baseDate,
        cells: [
          "I don't get the math part", "Tried to read but fell asleep", "Forgot my notebook again",
          "Help me with long division", "I feel behind everyone", "The project is too big",
          "My group didn't talk to me", "I want to quit this topic", "Zero homework done"
        ]
      },
      {
        studentId: 's2',
        studentName: 'Sam Chen',
        pageId: 'p2',
        pageTitle: 'Math Journal',
        date: baseDate,
        cells: [
          "Confusion on step 2", "Lost my calculator", "Late to class",
          "Is there a tutor?", "Sad today", "Math is hard",
          "No one helped", "Did half the page", "Need more time"
        ]
      }
    ],
    'high-achiever': [
      {
        studentId: 's3',
        studentName: 'Maya Johnson',
        pageId: 'p3',
        pageTitle: 'Advanced Bio Log',
        date: baseDate,
        cells: [
          "Mastered mitosis", "Read 3 extra chapters", "Peer tutored 2 friends",
          "Project finished early", "Ready for the exam", "Asking for extra credit",
          "Lab results were 99% accurate", "Love this subject", "Going to the library later"
        ]
      }
    ],
    'emotional': [
      {
        studentId: 's4',
        studentName: 'Leo Kim',
        pageId: 'p4',
        pageTitle: 'Personal Reflections',
        date: baseDate,
        cells: [
          "Feeling very anxious", "Fighting with my friend", "Didn't eat lunch",
          "Can't concentrate", "Headache all day", "Want to go home",
          "Music helped a bit", "Scared about the test", "Cried during break"
        ]
      }
    ],
    'balanced': [
      {
        studentId: 's5',
        studentName: 'Jordan Smith',
        pageId: 'p5',
        pageTitle: 'Weekly Check-in',
        date: baseDate,
        cells: [
          "Good weekend", "History was okay", "Need to study Spanish",
          "Soccer practice was great", "Busy week ahead", "Done with Science",
          "Met my goal", "Feeling 7/10", "Need to find my gym bag"
        ]
      }
    ]
  };

  return scenarios[scenario] || scenarios['balanced'];
};
