/**
 * Mock API responses for BDD testing
 *
 * These mocks let us run the full pipeline logic without hitting real APIs.
 * Each mock returns realistic data structures matching the actual API responses.
 */

const mockData = {
  // --- LinkedIn Jobs ---
  linkedinJobs: (roleTitle, location, count = 3) => Array.from({ length: count }, (_, i) => ({
    companyName: ['Northgate Financial', 'Halcyon Build', 'Meridian Infrastructure'][i % 3],
    roleTitle: roleTitle,
    location: location || 'Toronto, ON',
    source: 'LinkedIn',
    jobPostingUrl: `https://linkedin.com/jobs/view/${1000 + i}`,
    salary: i === 0 ? '$65,000 - $85,000' : '',
    datePosted: new Date().toISOString().split('T')[0],
    description: `We are looking for a ${roleTitle} to join our growing team.`,
    workArrangement: ['Hybrid', 'Remote', 'On-site'][i % 3]
  })),

  // --- Indeed Jobs ---
  indeedJobs: (roleTitle, location, count = 2) => Array.from({ length: count }, (_, i) => ({
    companyName: ['Cascadia Steel', 'Ashford & Vale'][i % 2],
    roleTitle: roleTitle,
    location: location || 'Toronto, ON',
    source: 'Indeed',
    jobPostingUrl: `https://indeed.ca/viewjob?jk=abc${i}`,
    salary: '$70,000 - $90,000',
    datePosted: new Date().toISOString().split('T')[0],
    description: `Exciting opportunity for a ${roleTitle}.`,
    workArrangement: 'Hybrid'
  })),

  // --- Apollo Company ---
  apolloCompany: (companyName) => ({
    name: companyName,
    industry: 'Financial Services',
    headcount: '10,001+',
    foundedYear: 1992,
    domain: `${companyName.toLowerCase().replace(/\s/g, '')}.com`,
    techStack: ['Salesforce', 'Workday'],
    description: `${companyName} is a leading financial institution.`
  }),

  // --- Apollo Contact ---
  apolloContact: (companyName, tier = 1) => ({
    name: 'Jane Recruiter',
    title: tier === 1 ? 'Talent Acquisition Manager' : 'VP Human Resources',
    email: `jrecruiter@${companyName.toLowerCase().replace(/\s/g, '')}.com`,
    linkedinUrl: 'https://linkedin.com/in/janerecruiter',
    phone: null
  }),

  // --- PDL Candidates ---
  pdlCandidates: (roleTitle, count = 5) => Array.from({ length: count }, (_, i) => ({
    fullName: ['Jordan Lee', 'Michael Chen', 'Priya Patel', 'James Wilson', 'Maria Santos'][i],
    firstName: ['Jordan', 'Michael', 'Priya', 'James', 'Maria'][i],
    lastName: ['Lee', 'Chen', 'Patel', 'Wilson', 'Santos'][i],
    currentTitle: roleTitle,
    currentCompany: ['Northgate Financial', 'Cascadia Steel', 'Ashford & Vale', 'Bellamy Rowe', 'Calder Whitmore'][i],
    location: 'Toronto, Ontario, Canada',
    linkedinUrl: `https://linkedin.com/in/person${i}`,
    yearsExperience: [5, 8, 3, 12, 6][i],
    jobChangeRecency: [3, 10, 24, 2, 15][i], // months
    skills: ['Legal Research', 'Contract Review', 'Litigation Support'],
    availabilitySignal: i < 2 ? 'Recently changed roles' : 'Unknown'
  })),

  // --- Claude Synthesis ---
  claudeSynthesis: (companyName, roleTitle) => ({
    marketNarrative: `The ${roleTitle} market in Toronto is moderately competitive. ${companyName} is actively hiring.`,
    salaryRange: '$65,000 - $90,000 annually',
    timeToFill: '30-45 days',
    activeCandidates: 15,
    passiveCandidates: 45,
    supplyDemandSignal: 'Moderate — balanced supply and demand',
    salesTalkingPoints: [
      `${companyName} expanding their legal team — 3 open roles`,
      'Time-to-fill above industry average — urgency signal',
      'Competitors also hiring — market is heating up'
    ],
    candidatePitchPoints: [
      'Hybrid work arrangement available',
      'Competitive compensation above market median',
      'Growing team with career advancement potential'
    ],
    roleChangeDrivers: 'Regulatory expansion driving legal hiring across financial services',
    hiringRiskFlag: 'None identified',
    marketTrend: 'Legal roles up 12% YoY in financial services',
    candidate1: { name: 'Jordan Lee', title: roleTitle, yearsExperience: 5, topSkills: ['Legal Research'], matchLabel: 'WARM' },
    candidate2: { name: 'Michael Chen', title: roleTitle, yearsExperience: 8, topSkills: ['Contract Review'], matchLabel: 'POSSIBLE' },
    candidate3: { name: 'Priya Patel', title: roleTitle, yearsExperience: 3, topSkills: ['Litigation'], matchLabel: 'STRETCH' },
    ctaCopy: `${companyName} needs a ${roleTitle} now. We have 3 warm candidates ready. Let's connect today.`,
    digestBullets: [
      `${companyName} actively hiring ${roleTitle}`,
      'Market is moderately competitive',
      '3 qualified candidates identified'
    ]
  }),

  // --- Airtable Write Response ---
  airtableRecord: (id = 'recABC123') => ({
    id: id,
    createdTime: new Date().toISOString(),
    fields: {}
  })
};

module.exports = mockData;
